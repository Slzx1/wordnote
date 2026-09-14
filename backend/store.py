import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get('WORDNOTE_DATA_DIR', str(ROOT / 'data')))
DB = DATA / 'wordnote.sqlite3'
ENV = Path(os.environ.get('WORDNOTE_ENV_FILE', str(ROOT / '.env')))


def now():
    return datetime.now(timezone.utc).isoformat()


def dump(value):
    return json.dumps(value, ensure_ascii=False)


@contextmanager
def connect():
    db = sqlite3.connect(DB, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def init():
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'pdfs').mkdir(exist_ok=True)
    (DATA / 'previews').mkdir(exist_ok=True)
    with connect() as db:
        db.execute('PRAGMA journal_mode = WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL,
            hash TEXT NOT NULL, pages INTEGER NOT NULL, warnings TEXT NOT NULL,
            bookmark INTEGER DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS questions (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
            ordinal INTEGER NOT NULL, number INTEGER NOT NULL, page INTEGER NOT NULL,
            sentence TEXT NOT NULL, options TEXT NOT NULL, issues TEXT NOT NULL,
            original TEXT NOT NULL, status TEXT NOT NULL, note TEXT, candidate TEXT,
            source TEXT DEFAULT '', manual INTEGER DEFAULT 0, review INTEGER DEFAULT 0,
            error TEXT DEFAULT '', version INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL REFERENCES questions(id),
            kind TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, context TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
            ids TEXT NOT NULL, status TEXT NOT NULL, completed INTEGER DEFAULT 0,
            failed INTEGER DEFAULT 0, error TEXT DEFAULT '', stop INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, question_id TEXT NOT NULL,
            model TEXT NOT NULL, status TEXT NOT NULL, response TEXT, usage TEXT,
            error TEXT DEFAULT '', prompt_version TEXT DEFAULT '1', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS lookup_cache (
            key TEXT PRIMARY KEY, result TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL
        );
        ''')
        if 'context' not in {r['name'] for r in db.execute('PRAGMA table_info(revisions)')}:
            db.execute('ALTER TABLE revisions ADD COLUMN context TEXT')
        db.execute("UPDATE jobs SET status='interrupted',error='应用重启，任务可继续' WHERE status IN ('running','queued')")
        db.execute("UPDATE questions SET status=CASE WHEN note IS NULL THEN 'ready' ELSE 'done' END WHERE status IN ('queued','generating')")


def question(row):
    q = dict(row)
    for key in ('options', 'issues', 'original', 'note', 'candidate'):
        q[key] = json.loads(q[key]) if q.get(key) else None
    from .models import missing_explanations
    q['missing_explanations'] = missing_explanations(q['note'])
    return q


def revision(db, qid, kind, source, payload):
    q = db.execute('SELECT sentence,options FROM questions WHERE id=?', (qid,)).fetchone()
    context = {'sentence': q['sentence'], 'options': json.loads(q['options'])} if q else None
    db.execute('INSERT INTO revisions(question_id,kind,source,payload,context,created_at) VALUES(?,?,?,?,?,?)',
               (qid, kind, source, dump(payload), dump(context), now()))
