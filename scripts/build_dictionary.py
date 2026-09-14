"""Build a read-only lookup index from the upstream ECDICT CSV."""
import argparse
import csv
import hashlib
import json
import sqlite3
from pathlib import Path


def build(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.building.sqlite3')
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(temporary)
    try:
        db.executescript('''
            CREATE TABLE entries (word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT,
                translation TEXT NOT NULL, definition TEXT, exchange TEXT) WITHOUT ROWID;
            CREATE TABLE forms (form TEXT, lemma TEXT, PRIMARY KEY(form,lemma)) WITHOUT ROWID;
        ''')
        with source.open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            if not {'word', 'translation', 'phonetic', 'exchange'} <= set(reader.fieldnames or []):
                raise ValueError('Not an ECDICT CSV')
            for row in reader:
                word = row['word'].strip()
                if not word or not row['translation'].strip():
                    continue
                db.execute('INSERT OR IGNORE INTO entries VALUES(?,?,?,?,?)',
                    (word, row['phonetic'], row['translation'].replace('\\n', '\n'),
                     row['definition'].replace('\\n', '\n'), row['exchange']))
                for variation in row['exchange'].split('/'):
                    kind, sep, value = variation.partition(':')
                    if sep and kind in ('p', 'd', 'i', '3', 'r', 't', 's'):
                        for form in value.split(','):
                            db.execute('INSERT OR IGNORE INTO forms VALUES(?,?)', (form.lower().strip(), word.lower()))
        count = db.execute('SELECT count(*) FROM entries').fetchone()[0]
        if count < 100000:
            raise ValueError(f'Incomplete dictionary: {count} entries')
        db.commit()
        db.execute('VACUUM')
    finally:
        db.close()
    temporary.replace(target)
    provenance = {'source': 'https://github.com/skywind3000/ECDICT', 'file': 'ecdict.csv',
        'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'entries': count,
        'license': 'MIT', 'index_format': 1}
    target.with_suffix('.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(provenance))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    build(args.source, args.target)
