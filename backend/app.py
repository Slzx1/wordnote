import hashlib
import json
import re
import shutil
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import pdfplumber
from dotenv import set_key
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import speech, store
from .generation import Generator, config
from .models import CompleteNote, Note, filled_parts
from .enrichment import migrate_sample_explanations
from .dictionary import LookupFailure, LookupInput, lookup
from .parser import issues_for, parse_pdf, read_existing_notes

generator = Generator()
preview_lock = threading.Lock()


def require_document(db, doc_id):
    row = db.execute('SELECT * FROM documents WHERE id=?', (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, '文档不存在')
    return dict(row)


def require_question(db, qid):
    row = db.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
    if not row:
        raise HTTPException(404, '题目不存在')
    return store.question(row)


def add_document(path, filename, parsed, digest, existing=None):
    doc_id = uuid.uuid4().hex
    shutil.copyfile(path, store.DATA / 'pdfs' / f'{doc_id}.pdf')
    with store.connect() as db:
        db.execute('INSERT INTO documents(id,title,filename,hash,pages,warnings,created_at) VALUES(?,?,?,?,?,?,?)',
            (doc_id, parsed['title'] or Path(filename).stem, filename, digest, parsed['pages'], store.dump(parsed['warnings']), store.now()))
        for index, q in enumerate(parsed['questions']):
            qid = uuid.uuid4().hex
            note = existing.get(q['number']) if existing else None
            value = note.model_dump() if note else None
            status = 'invalid' if q['issues'] else 'done' if note else 'ready'
            source = '已有 Markdown' if note else ''
            db.execute('''INSERT INTO questions(id,document_id,ordinal,number,page,sentence,options,issues,original,status,note,source,review)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (qid, doc_id, index, q['number'], q['page'], q['sentence'], store.dump(q['options']), store.dump(q['issues']),
                 store.dump(q), status, store.dump(value) if value else None, source, bool(note)))
            store.revision(db, qid, 'original', 'PDF', q)
            if value:
                store.revision(db, qid, 'imported', source, value)
    return doc_id


def seed():
    with store.connect() as db:
        if db.execute("SELECT 1 FROM settings WHERE key='seeded'").fetchone():
            return
    for path in sorted(store.ROOT.glob('*.pdf')):
        match = re.search(r'练习([12])$', path.stem)
        notes_path = store.ROOT / f'词汇练习笔记{match[1]}.md' if match else None
        if not notes_path or not notes_path.exists():
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with store.connect() as db:
            if db.execute('SELECT 1 FROM documents WHERE hash=?', (digest,)).fetchone():
                continue
        add_document(path, path.name, parse_pdf(path), digest, read_existing_notes(notes_path))
    with store.connect() as db:
        db.execute("INSERT OR REPLACE INTO settings VALUES('seeded','true')")


@asynccontextmanager
async def lifespan(app):
    store.init()
    if not __import__('os').environ.get('WORDNOTE_SKIP_SEED'):
        await run_in_threadpool(seed)
        await run_in_threadpool(migrate_sample_explanations)
    yield
    await generator.close()


app = FastAPI(title='Wordnote', lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])


@app.middleware('http')
async def local_origin(request: Request, call_next):
    origin = request.headers.get('origin')
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin:
        parsed = urlparse(origin)
        if parsed.hostname not in ('127.0.0.1', 'localhost'):
            return JSONResponse({'detail': '仅接受来自本机网页的操作'}, status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/api/health')
def health():
    return {'status': 'ok'}


@app.post('/api/dictionary/lookup')
async def dictionary_lookup(body: LookupInput):
    try:
        return await lookup(body)
    except LookupFailure as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@app.get('/api/speech/voices')
def system_voices():
    return speech.voices()


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: str = Field(min_length=1, max_length=100)
    rate: float = Field(default=1, ge=0.6, le=1.5)


@app.post('/api/speech')
def system_speech(body: SpeechInput):
    try:
        output = speech.synthesize(body.text, body.voice, body.rate)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, '本机英语语音生成失败，请重试或切换音色') from exc
    return FileResponse(output, media_type='audio/wav')


@app.get('/api/settings')
def settings():
    cfg = config()
    return {'configured': bool(cfg['api_key']), 'model': cfg['model']}


class SettingsInput(BaseModel):
    model: str = Field(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9._:/-]+$')
    api_key: str | None = Field(default=None, max_length=300)


@app.put('/api/settings')
def save_settings(body: SettingsInput):
    if body.api_key is not None:
        key = body.api_key.strip()
        if key and (not key.isascii() or any(c.isspace() for c in key)):
            raise HTTPException(422, '密钥格式不正确')
        if key:
            set_key(str(store.ENV), 'DEEPSEEK_API_KEY', key)
    with store.connect() as db:
        db.execute("INSERT OR REPLACE INTO settings VALUES('model',?)", (body.model,))
    return settings()


@app.get('/api/documents')
def documents():
    with store.connect() as db:
        rows = db.execute('''SELECT d.*, count(q.id) AS total,
            sum(CASE WHEN q.note IS NOT NULL THEN 1 ELSE 0 END) AS completed,
            sum(CASE WHEN q.review=1 THEN 1 ELSE 0 END) AS review_count
            FROM documents d LEFT JOIN questions q ON q.document_id=d.id
            GROUP BY d.id ORDER BY d.created_at''').fetchall()
        return [dict(row) | {'warnings': json.loads(row['warnings'])} for row in rows]


@app.get('/api/documents/{doc_id}')
def document(doc_id: str):
    with store.connect() as db:
        doc = require_document(db, doc_id)
        doc['warnings'] = json.loads(doc['warnings'])
        doc['questions'] = [store.question(row) for row in db.execute('SELECT * FROM questions WHERE document_id=? ORDER BY ordinal', (doc_id,))]
        row = db.execute('SELECT * FROM jobs WHERE document_id=? ORDER BY created_at DESC LIMIT 1', (doc_id,)).fetchone()
        doc['job'] = (dict(row) | {'total': len(json.loads(row['ids']))}) if row else None
    for q in doc['questions']:
        q['parts'] = filled_parts(q['sentence'], q['options'], q['note']['answer'] if q['note'] else None)
    return doc


@app.delete('/api/documents/{doc_id}')
def delete_document(doc_id: str):
    if not re.fullmatch(r'[a-f0-9]{32}', doc_id):
        raise HTTPException(404, '文档不存在')
    # Share the renderer lock so a preview cannot be recreated during deletion.
    with preview_lock:
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            require_document(db, doc_id)
            if db.execute("SELECT 1 FROM jobs WHERE document_id=? AND status IN ('queued','running')", (doc_id,)).fetchone():
                raise HTTPException(409, '此资料正在生成，请先停止生成并等待任务结束后再删除')
            db.execute('''DELETE FROM calls WHERE job_id IN (SELECT id FROM jobs WHERE document_id=?)
                OR question_id IN (SELECT id FROM questions WHERE document_id=?)''', (doc_id, doc_id))
            db.execute('DELETE FROM revisions WHERE question_id IN (SELECT id FROM questions WHERE document_id=?)', (doc_id,))
            db.execute('DELETE FROM jobs WHERE document_id=?', (doc_id,))
            db.execute('DELETE FROM questions WHERE document_id=?', (doc_id,))
            db.execute('DELETE FROM documents WHERE id=?', (doc_id,))
        cleanup_failed = False
        paths = [store.DATA / 'pdfs' / f'{doc_id}.pdf', * (store.DATA / 'previews').glob(f'{doc_id}-*.png')]
        allowed_parents = {(store.DATA / name).resolve() for name in ('pdfs', 'previews')}
        for path in paths:
            try:
                if path.resolve().parent not in allowed_parents:
                    raise OSError('Unexpected document asset path')
                path.unlink(missing_ok=True)
            except OSError:
                cleanup_failed = True
    warning = '资料记录已删除，但部分 PDF 或预览文件被占用，未能清理。可关闭 PDF 后清理 data 目录中的对应文件。' if cleanup_failed else ''
    return {'ok': True, 'warning': warning}


@app.post('/api/documents')
async def upload(file: UploadFile = File(...), duplicate: bool = False):
    filename = Path((file.filename or 'document.pdf').replace('\\', '/')).name
    if not filename.lower().endswith('.pdf'):
        raise HTTPException(400, '请选择 PDF 文件')
    temp = store.DATA / 'pdfs' / f'upload-{uuid.uuid4().hex}.tmp'
    size, digest = 0, hashlib.sha256()
    try:
        with temp.open('wb') as stream:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 25 * 1024 * 1024:
                    raise HTTPException(413, '单份 PDF 最大为 25 MB')
                digest.update(chunk)
                stream.write(chunk)
        with temp.open('rb') as stream:
            if b'%PDF-' not in stream.read(1024):
                raise HTTPException(400, '文件不是有效的 PDF')
        with store.connect() as db:
            row = db.execute('SELECT id FROM documents WHERE hash=? ORDER BY created_at LIMIT 1', (digest.hexdigest(),)).fetchone()
        if row and not duplicate:
            return JSONResponse({'detail': '这份 PDF 已导入', 'duplicate_id': row['id']}, status_code=409)
        try:
            parsed = await run_in_threadpool(parse_pdf, temp)
        except Exception as exc:
            message = str(exc) if isinstance(exc, ValueError) else '无法读取 PDF，请确认文件完整且未加密'
            raise HTTPException(400, message) from exc
        doc_id = await run_in_threadpool(add_document, temp, filename, parsed, digest.hexdigest())
        return {'id': doc_id}
    finally:
        temp.unlink(missing_ok=True)
        await file.close()


@app.get('/api/documents/{doc_id}/pdf')
def pdf(doc_id: str):
    with store.connect() as db:
        doc = require_document(db, doc_id)
    return FileResponse(store.DATA / 'pdfs' / f'{doc_id}.pdf', media_type='application/pdf', filename=doc['filename'], content_disposition_type='inline')


@app.get('/api/documents/{doc_id}/preview/{page}')
def preview(doc_id: str, page: int):
    # PDFium is not thread-safe; render previews serially across requests.
    with preview_lock:
        with store.connect() as db:
            doc = require_document(db, doc_id)
        if not 1 <= page <= doc['pages']:
            raise HTTPException(404, '页码不存在')
        output = store.DATA / 'previews' / f'{doc_id}-{page}.png'
        if not output.exists():
            with pdfplumber.open(store.DATA / 'pdfs' / f'{doc_id}.pdf') as source:
                source.pages[page - 1].to_image(resolution=90).save(output, format='PNG')
    return FileResponse(output, media_type='image/png')


class Bookmark(BaseModel):
    ordinal: int = Field(ge=0)


@app.put('/api/documents/{doc_id}/bookmark')
def bookmark(doc_id: str, body: Bookmark):
    with store.connect() as db:
        require_document(db, doc_id)
        count = db.execute('SELECT count(*) FROM questions WHERE document_id=?', (doc_id,)).fetchone()[0]
        db.execute('UPDATE documents SET bookmark=? WHERE id=?', (min(body.ordinal, max(count - 1, 0)), doc_id))
    return {'ok': True}


class NoteEdit(BaseModel):
    note: CompleteNote
    version: int


@app.put('/api/questions/{qid}/note')
def edit_note(qid: str, body: NoteEdit):
    with store.connect() as db:
        q = require_question(db, qid)
        if q['version'] != body.version:
            raise HTTPException(409, '笔记已更新，请关闭编辑窗口后重新打开')
        if q['issues']:
            raise HTTPException(422, '请先修正原题解析')
        changed_answer = q['note'] and body.note.answer != q['note']['answer']
        value = body.note.model_dump()
        store.revision(db, qid, 'edited', '人工修改', value)
        db.execute("UPDATE questions SET note=?,source='人工修改',manual=1,review=?,version=version+1,status='done',error='' WHERE id=?",
            (store.dump(value), bool(changed_answer or body.note.uncertainty or q['review']), qid))
    return {'ok': True}


class SourceEdit(BaseModel):
    number: int = Field(ge=1, le=9999)
    sentence: str = Field(min_length=10, max_length=10000)
    options: dict[str, str]
    version: int


@app.put('/api/questions/{qid}/source')
def edit_source(qid: str, body: SourceEdit):
    issues = issues_for(body.sentence, body.options)
    if issues:
        raise HTTPException(422, '；'.join(issues))
    with store.connect() as db:
        q = require_question(db, qid)
        if q['version'] != body.version:
            raise HTTPException(409, '题目已更新，请重新打开编辑窗口')
        if q['status'] in ('queued', 'generating'):
            raise HTTPException(409, '请等待该题生成结束或停止任务后再修正原文')
        if db.execute('SELECT 1 FROM questions WHERE document_id=? AND number=? AND id<>?', (q['document_id'], body.number, qid)).fetchone():
            raise HTTPException(422, '此题号已存在')
        store.revision(db, qid, 'source_edited', '人工修正原文', body.model_dump())
        db.execute("UPDATE questions SET number=?,sentence=?,options=?,issues='[]',note=NULL,candidate=NULL,source='',manual=0,review=1,status='ready',version=version+1,error='' WHERE id=?",
            (body.number, body.sentence, store.dump(body.options), qid))
    return {'ok': True}


class ReviewInput(BaseModel):
    review: bool


@app.put('/api/questions/{qid}/review')
def set_review(qid: str, body: ReviewInput):
    with store.connect() as db:
        require_question(db, qid)
        db.execute('UPDATE questions SET review=?,version=version+1 WHERE id=?', (body.review, qid))
    return {'ok': True}


class CandidateInput(BaseModel):
    accept: bool
    version: int


@app.post('/api/questions/{qid}/candidate')
def candidate(qid: str, body: CandidateInput):
    with store.connect() as db:
        q = require_question(db, qid)
        if q['version'] != body.version:
            raise HTTPException(409, '笔记已更新，请重新查看候选版本')
        if not q['candidate']:
            raise HTTPException(404, '没有候选版本')
        if body.accept:
            try:
                value = CompleteNote.model_validate(q['candidate']).model_dump()
            except ValueError as exc:
                raise HTTPException(422, '此旧候选版本缺少完整选项解释，请重新生成') from exc
            store.revision(db, qid, 'accepted', '采用模型候选', value)
            db.execute("UPDATE questions SET note=?,source='采用模型候选',manual=1,review=?,version=version+1 WHERE id=?",
                (store.dump(value), bool(value['uncertainty']), qid))
        db.execute('UPDATE questions SET candidate=NULL WHERE id=?', (qid,))
    return {'ok': True}


@app.get('/api/questions/{qid}/history')
def history(qid: str):
    with store.connect() as db:
        require_question(db, qid)
        return [dict(row) | {'payload': json.loads(row['payload']), 'context': json.loads(row['context']) if row['context'] else None} for row in db.execute('SELECT * FROM revisions WHERE question_id=? ORDER BY id DESC', (qid,))]


class RestoreInput(BaseModel):
    revision_id: int
    version: int


@app.post('/api/questions/{qid}/restore')
def restore(qid: str, body: RestoreInput):
    with store.connect() as db:
        q = require_question(db, qid)
        if q['version'] != body.version or q['issues']:
            raise HTTPException(409, '题目已更新或原文仍需修正，请重新打开历史')
        row = db.execute('SELECT * FROM revisions WHERE id=? AND question_id=?', (body.revision_id, qid)).fetchone()
        if not row or row['kind'] in ('original', 'source_edited'):
            raise HTTPException(422, '此记录不是可恢复的笔记版本')
        context = json.loads(row['context']) if row['context'] else {'sentence': q['original']['sentence'], 'options': q['original']['options']}
        if context['sentence'] != q['sentence'] or context['options'] != q['options']:
            raise HTTPException(409, '此历史版本对应不同的题干或选项，请基于当前原题重新生成')
        value = Note.model_validate_json(row['payload']).model_dump()
        store.revision(db, qid, 'restored', '恢复历史版本', value)
        db.execute("UPDATE questions SET note=?,manual=1,review=1,source='恢复历史版本',version=version+1,status='done' WHERE id=?", (store.dump(value), qid))
    return {'ok': True}


class GenerateInput(BaseModel):
    question_ids: list[str] | None = None


@app.post('/api/documents/{doc_id}/generate')
async def generate(doc_id: str, body: GenerateInput):
    if not config()['api_key']:
        raise HTTPException(400, '请先在设置中配置 DeepSeek API Key')
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        require_document(db, doc_id)
        if db.execute("SELECT 1 FROM jobs WHERE document_id=? AND status IN ('queued','running')", (doc_id,)).fetchone():
            raise HTTPException(409, '此文档正在生成，请等待完成或先停止任务')
        questions = [store.question(row) for row in db.execute('SELECT * FROM questions WHERE document_id=? ORDER BY ordinal', (doc_id,))]
        if body.question_ids is not None:
            if not set(body.question_ids) <= {q['id'] for q in questions}:
                raise HTTPException(422, '包含不属于此文档的题目')
            ids = [q['id'] for q in questions if q['id'] in body.question_ids and not q['issues']]
        else:
            ids = [q['id'] for q in questions if not q['issues'] and (not q['note'] or q['status'] == 'error' or q['missing_explanations'])]
        if not ids:
            raise HTTPException(400, '没有可生成的题目，请先修正解析或选择单题重新生成')
        job_id = uuid.uuid4().hex
        db.execute('INSERT INTO jobs(id,document_id,ids,status,created_at) VALUES(?,?,?,?,?)', (job_id, doc_id, store.dump(ids), 'queued', store.now()))
        for qid in ids:
            db.execute("UPDATE questions SET status='queued',error='' WHERE id=?", (qid,))
    generator.start(job_id)
    return {'id': job_id}


@app.post('/api/documents/{doc_id}/stop')
def stop(doc_id: str):
    with store.connect() as db:
        require_document(db, doc_id)
        db.execute("UPDATE jobs SET stop=1 WHERE document_id=? AND status IN ('queued','running')", (doc_id,))
    return {'ok': True}


def markdown(doc):
    lines = [f"# {doc['title']}", '']
    if doc['warnings']:
        lines.extend(['> ' + '；'.join(doc['warnings']), ''])
    for q in doc['questions']:
        if not q['note']:
            lines.extend([f"**{q['number']}.** {q['sentence']}", '状态：待生成' + ('；' + '；'.join(q['issues']) if q['issues'] else ''), ''])
            lines.extend(f"- {label}) {word}" for label, word in q['options'].items())
            lines.append('')
            continue
        parts = q['parts']
        sentence = f'{parts[0]}**{parts[1]}**{parts[2]}' if parts[1] else parts[0]
        lines.extend([f"**{q['number']}.** {sentence}  ", f"答案：{q['note']['answer']}  "])
        lines.append(f"> 来源：{q['source']}" + ('；待核对' if q['review'] else ''))
        for option in q['note']['options']:
            phrases = ' / '.join('`' + p['text'].replace('`', '') + '`' for p in option['collocations'])
            correct = '正确。' if option['label'] == q['note']['answer'] else ''
            reason = option['reason'] if option['label'] not in q['missing_explanations'] else '解释待补充（旧版笔记）'
            lines.append(f"- {option['label']}) {q['options'][option['label']]}：{option['pos']} {option['meaning']}。搭配：{phrases}。{correct}解释：{reason}  ")
        if q['note']['uncertainty']:
            lines.append('待核对：' + q['note']['uncertainty'])
        if q['candidate']:
            lines.append('> 有尚未采用的候选版本，本次导出为当前版本。')
        lines.append('')
    return '\n'.join(lines)


@app.get('/api/documents/{doc_id}/markdown')
def export(doc_id: str):
    return Response(markdown(document(doc_id)), media_type='text/markdown; charset=utf-8')


DIST = store.ROOT / 'dist'
if DIST.exists():
    app.mount('/', StaticFiles(directory=DIST, html=True), name='frontend')
