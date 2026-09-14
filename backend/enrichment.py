import json
from functools import lru_cache

from . import store
from .models import CompleteNote


@lru_cache(maxsize=1)
def sample_reasons():
    return json.loads((store.ROOT / 'backend/assets/sample_explanations.json').read_text(encoding='utf-8'))


def enrich_sample(note, series: str, number: int):
    reasons = sample_reasons().get(series, {}).get(str(number))
    if not reasons:
        return note
    value = note.model_dump()
    for option in value['options']:
        option['reason'] = reasons[ord(option['label']) - ord('A')]
    if series == '2' and number == 8:
        value['options'][0]['pos'] = 'adj.'
        value['options'][0]['meaning'] = '徒劳的；自负的（in vain：徒劳地）'
    if series == '2' and number == 5:
        value['options'][3]['collocations'] = [{'text': 'eternal cycle'}, {'text': 'eternal life'}]
    return CompleteNote.model_validate(value)


def migrate_sample_explanations():
    from .parser import parse_pdf, read_existing_notes

    with store.connect() as db:
        if db.execute("SELECT 1 FROM settings WHERE key='all-option-explanations-v1'").fetchone():
            return
    for series in ('1', '2'):
        pdf = store.ROOT / f'2026秋学期英语辅导词汇练习{series}.pdf'
        md = store.ROOT / f'词汇练习笔记{series}.md'
        if not pdf.exists() or not md.exists():
            continue
        parsed = {q['number']: q for q in parse_pdf(pdf)['questions']}
        raw_notes = read_existing_notes(md, enrich=False)
        with store.connect() as db:
            rows = db.execute('''SELECT q.* FROM questions q JOIN documents d ON d.id=q.document_id
                WHERE d.filename=? AND q.note IS NOT NULL''', (pdf.name,)).fetchall()
            for row in rows:
                q = store.question(row)
                original = parsed.get(q['number'])
                original_note = raw_notes.get(q['number'])
                if not original or not original_note or q['sentence'] != original['sentence'] or q['options'] != original['options']:
                    continue
                updated = enrich_sample(original_note, series, q['number']).model_dump()
                if q['note'] == updated:
                    continue
                # Existing edits remain adopted. A reviewed sample is offered as
                # a candidate instead of overwriting the user's own content.
                if q['manual'] or q['note'] != original_note.model_dump():
                    if not q['candidate']:
                        db.execute('UPDATE questions SET candidate=?,version=version+1 WHERE id=?', (store.dump(updated), q['id']))
                        store.revision(db, q['id'], 'sample_candidate', '补齐全部选项解释', updated)
                else:
                    db.execute("UPDATE questions SET note=?,source='已有 Markdown · 已补齐解释',review=1,version=version+1 WHERE id=?", (store.dump(updated), q['id']))
                    store.revision(db, q['id'], 'enriched', '补齐全部选项解释', updated)
    with store.connect() as db:
        db.execute("INSERT OR REPLACE INTO settings VALUES('all-option-explanations-v1','true')")
