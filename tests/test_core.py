import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as application, store
from backend.generation import Generator, PermanentError
from backend.models import CompleteNote, Note, expand_phrase, filled_parts, speech_text
from backend.parser import parse_pages, parse_pdf, read_existing_notes

ROOT = Path(__file__).resolve().parents[1]
PDFS = sorted(ROOT.glob('*.pdf'))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'DATA', tmp_path)
    monkeypatch.setattr(store, 'DB', tmp_path / 'test.sqlite3')
    monkeypatch.setattr(store, 'ENV', tmp_path / '.env')
    monkeypatch.setenv('DEEPSEEK_API_KEY', '')
    monkeypatch.setenv('WORDNOTE_SKIP_SEED', '1')
    monkeypatch.setattr(application, 'config', lambda: {'api_key': '', 'model': 'deepseek-flash'})
    with TestClient(application.app) as client:
        yield client


def upload(client, index=0):
    response = client.post('/api/documents', files={'file': (PDFS[index].name, PDFS[index].read_bytes(), 'application/pdf')})
    assert response.status_code == 200, response.text
    return client.get('/api/documents/' + response.json()['id']).json()


def sample_note():
    return next(iter(read_existing_notes(ROOT / '词汇练习笔记1.md').values())).model_dump()


def test_sample_extraction_and_sentence_preservation():
    for pdf in PDFS:
        parsed = parse_pdf(pdf)
        assert parsed['pages'] == 2
        assert len(parsed['questions']) == 30
        assert [q['number'] for q in parsed['questions']] == list(range(1, 31))
        assert all(not q['issues'] and set(q['options']) == set('ABCD') for q in parsed['questions'])
        assert sum(len(q['options']) for q in parsed['questions']) == 120
    q = parse_pdf(PDFS[1])['questions']
    assert ''.join(filled_parts(q[4]['sentence'], q[4]['options'], 'D')) == 'The eternal cycle of life and death is a subject of interest to scientists and philosophers alike.'
    assert 'live to eat or eat to live' in ''.join(filled_parts(q[8]['sentence'], q[8]['options'], 'B'))
    q1 = parse_pdf(PDFS[0])['questions']
    assert 'are alive today' in q1[9]['sentence']
    assert 'essence of' in ''.join(filled_parts(q1[10]['sentence'], q1[10]['options'], 'A'))
    assert 'collided with a light plane' in ''.join(filled_parts(q1[26]['sentence'], q1[26]['options'], 'D'))


def test_cross_page_question_and_invalid_input():
    result = parse_pages(['Title\n1. Some ____ text\nA) one B) two', 'C) three D) four\n3. Another ____ sentence.\nA) five B) six C) seven'])
    assert result['questions'][0]['page'] == 1
    assert not result['questions'][0]['issues']
    assert result['questions'][1]['issues']
    assert parse_pages([''])['warnings']


def test_note_import_and_phrase_expansion():
    for number in (1, 2):
        notes = read_existing_notes(ROOT / f'词汇练习笔记{number}.md')
        assert len(notes) == 30
        assert all(len(n.options) == 4 for n in notes.values())
    assert expand_phrase('have a quarrel about/over sth') == ['have a quarrel about sth', 'have a quarrel over sth']
    assert expand_phrase('conform to/with rules/standards') == ['conform to rules', 'conform to standards', 'conform with rules', 'conform with standards']
    assert speech_text('deprive sb of sth...') == 'deprive somebody of something'


def test_model_schema_rejects_invalid_answers_duplicate_labels_and_missing_fields():
    note = sample_note()
    bad = copy.deepcopy(note); bad['answer'] = 'E'
    with pytest.raises(ValueError): Note.model_validate(bad)
    bad = copy.deepcopy(note); bad['options'][1]['label'] = 'A'
    with pytest.raises(ValueError): Note.model_validate(bad)
    bad = copy.deepcopy(note); bad['options'][1]['meaning'] = ' '
    with pytest.raises(ValueError): Note.model_validate(bad)
    bad = copy.deepcopy(note); bad['sentence'] = 'modified sentence'
    with pytest.raises(ValueError): Note.model_validate(bad)


def test_every_option_requires_a_substantive_explanation(client):
    note = sample_note()
    assert CompleteNote.model_validate(note)
    for option_index in range(4):
        for reason in ('', '不合', '不符合语境'):
            bad = copy.deepcopy(note); bad['options'][option_index]['reason'] = reason
            with pytest.raises(ValueError): CompleteNote.model_validate(bad)
    doc = upload(client); q = doc['questions'][0]
    bad = copy.deepcopy(note); bad['options'][3]['reason'] = ''
    response = client.put(f"/api/questions/{q['id']}/note", json={'note': bad, 'version': 0})
    assert response.status_code == 422


def test_sample_explanations_migrate_without_overwriting_user_edits(client):
    from backend.enrichment import migrate_sample_explanations
    doc = upload(client)
    legacy = read_existing_notes(ROOT / '词汇练习笔记1.md', enrich=False)
    with store.connect() as db:
        for q in doc['questions']:
            db.execute("UPDATE questions SET note=?,source='已有 Markdown',status='done' WHERE id=?", (store.dump(legacy[q['number']].model_dump()), q['id']))
        manually_edited = legacy[2].model_dump()
        manually_edited['options'][0]['meaning'] = '用户自己写的释义'
        db.execute('UPDATE questions SET note=?,manual=1 WHERE id=?', (store.dump(manually_edited), doc['questions'][1]['id']))
    migrate_sample_explanations()
    after = client.get('/api/documents/' + doc['id']).json()
    assert all(not q['missing_explanations'] for q in after['questions'] if q['number'] != 2)
    assert after['questions'][1]['note']['options'][0]['meaning'] == '用户自己写的释义'
    assert CompleteNote.model_validate(after['questions'][1]['candidate'])
    history = client.get(f"/api/questions/{doc['questions'][0]['id']}/history").json()
    assert any(r['kind'] == 'enriched' for r in history)
    migrate_sample_explanations()
    assert len(client.get(f"/api/questions/{doc['questions'][0]['id']}/history").json()) == len(history)


def test_offline_dictionary_arbitrary_words_forms_and_phrases(client, monkeypatch):
    from backend import dictionary
    def never_configure(): raise AssertionError('Offline lookup must not require DeepSeek')
    monkeypatch.setattr(dictionary, 'config', never_configure)
    for text, expected in [('scientist', '科学家'), ('planet', '行星'), ('ingredients', '材料'),
                           ('on the premise that...', '前提'), ('enhance efficiency', '提高效率')]:
        response = client.post('/api/dictionary/lookup', json={'text': text})
        assert response.status_code == 200
        assert expected in response.json()['translation']
        assert response.json()['kind'] == 'local'


def test_dictionary_context_cache_and_missing_key(client, monkeypatch):
    from backend import dictionary
    monkeypatch.setattr(dictionary, 'config', lambda: {'api_key': '', 'model': 'test-model'})
    body = {'text': 'A never seen example sentence for lookup.', 'context': 'first context'}
    assert client.post('/api/dictionary/lookup', json=body).json()['kind'] == 'unavailable'
    calls = []
    async def fake_translate(selection, cfg):
        calls.append(selection.context)
        return {'translation': '这是按语境翻译的示例句。', 'usage': '', 'examples': []}
    monkeypatch.setattr(dictionary, 'translate', fake_translate)
    monkeypatch.setattr(dictionary, 'config', lambda: {'api_key': 'test-only', 'model': 'test-model'})
    first = client.post('/api/dictionary/lookup', json=body).json()
    second = client.post('/api/dictionary/lookup', json=body).json()
    assert first['kind'] == 'model' and not first['cached']
    assert second['cached'] and len(calls) == 1
    client.post('/api/dictionary/lookup', json=body | {'context': 'another context'})
    assert len(calls) == 2
    monkeypatch.setattr(dictionary, 'config', lambda: {'api_key': '', 'model': 'test-model'})
    assert client.post('/api/dictionary/lookup', json=body).json()['cached']
    assert client.post('/api/dictionary/lookup', json={'text': 'a' * 2001}).status_code == 422
    assert client.post('/api/dictionary/lookup', json={'text': '中文'}).status_code == 422


def test_dictionary_model_failure_does_not_poison_cache(client, monkeypatch):
    from backend import dictionary
    monkeypatch.setattr(dictionary, 'config', lambda: {'api_key': 'test-only', 'model': 'test-model'})
    async def fail(*args): raise dictionary.LookupFailure('服务不可用')
    monkeypatch.setattr(dictionary, 'translate', fail)
    response = client.post('/api/dictionary/lookup', json={'text': 'unlisted lookup phrase here'})
    assert response.status_code == 502
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM lookup_cache').fetchone()[0] == 0


def test_dictionary_deepseek_transport_validation_and_auth(monkeypatch):
    from backend import dictionary
    captured = []
    original_client = httpx.AsyncClient
    async def no_delay(_): pass
    monkeypatch.setattr(dictionary.asyncio, 'sleep', no_delay)
    def handler(request):
        captured.append(json.loads(request.content))
        content = '{}' if len(captured) == 1 else json.dumps({'translation': '这是一整句的译文。', 'usage': '', 'examples': []})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]})
    monkeypatch.setattr(dictionary.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    selection = dictionary.LookupInput(text='A complete sentence to translate.', context='Its source sentence.')
    translated = asyncio.run(dictionary.translate(selection, {'api_key': 'test-only', 'model': 'test-model'}))
    assert translated['translation'] == '这是一整句的译文。'
    assert len(captured) == 2
    assert captured[0]['response_format'] == {'type': 'json_object'}
    assert json.loads(captured[0]['messages'][1]['content']) == {'text': selection.text, 'context': selection.context}
    denied = []
    def unauthorized(request):
        denied.append(1)
        return httpx.Response(401)
    monkeypatch.setattr(dictionary.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(unauthorized), **kwargs))
    with pytest.raises(dictionary.LookupFailure, match='密钥无效'):
        asyncio.run(dictionary.translate(selection, {'api_key': 'test-only', 'model': 'test-model'}))
    assert len(denied) == 1


def test_upload_duplicate_preview_and_markdown(client):
    doc = upload(client)
    assert len(doc['questions']) == 30
    same = client.post('/api/documents', files={'file': (PDFS[0].name, PDFS[0].read_bytes())})
    assert same.status_code == 409 and same.json()['duplicate_id'] == doc['id']
    copied = client.post('/api/documents?duplicate=true', files={'file': (PDFS[0].name, PDFS[0].read_bytes())})
    assert copied.status_code == 200 and copied.json()['id'] != doc['id']
    preview = client.get(f"/api/documents/{doc['id']}/preview/1")
    assert preview.status_code == 200 and preview.content.startswith(b'\x89PNG')
    assert client.get(f"/api/documents/{doc['id']}/preview/99").status_code == 404
    markdown = client.get(f"/api/documents/{doc['id']}/markdown").text
    assert markdown.count('状态：待生成') == 30
    assert client.post('/api/documents', files={'file': ('fake.pdf', b'not pdf')}).status_code == 400


def test_delete_document_cleans_owned_data_and_allows_reimport(client):
    doc = upload(client)
    other = upload(client, 1)
    q = doc['questions'][0]
    assert client.put(f"/api/questions/{q['id']}/note", json={'note': sample_note(), 'version': 0}).status_code == 200
    assert client.get(f"/api/documents/{doc['id']}/preview/1").status_code == 200
    prepare_job(doc, q)
    with store.connect() as db:
        db.execute("UPDATE jobs SET status='completed' WHERE id='test-job'")
        db.execute('INSERT INTO calls(job_id,question_id,model,status,created_at) VALUES(?,?,?,?,?)', ('test-job', q['id'], 'test', 'success', store.now()))
    response = client.delete('/api/documents/' + doc['id'])
    assert response.status_code == 200 and not response.json()['warning']
    assert client.get('/api/documents/' + doc['id']).status_code == 404
    assert client.get(f"/api/documents/{doc['id']}/pdf").status_code == 404
    assert client.get(f"/api/documents/{doc['id']}/preview/1").status_code == 404
    assert client.delete('/api/documents/' + doc['id']).status_code == 404
    assert not (store.DATA / 'pdfs' / f"{doc['id']}.pdf").exists()
    assert not list((store.DATA / 'previews').glob(doc['id'] + '-*'))
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM questions WHERE document_id=?', (doc['id'],)).fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM revisions WHERE question_id=?', (q['id'],)).fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM jobs WHERE document_id=?', (doc['id'],)).fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM calls WHERE question_id=?', (q['id'],)).fetchone()[0] == 0
    assert len(client.get('/api/documents/' + other['id']).json()['questions']) == 30
    assert (store.DATA / 'pdfs' / f"{other['id']}.pdf").exists()
    assert PDFS[0].exists()
    assert upload(client)['id'] != doc['id']


@pytest.mark.parametrize('status', ['queued', 'running'])
def test_delete_waits_until_generation_has_fully_stopped(client, status):
    doc = upload(client)
    prepare_job(doc, doc['questions'][0])
    with store.connect() as db:
        db.execute('UPDATE jobs SET status=?,stop=1', (status,))
    response = client.delete('/api/documents/' + doc['id'])
    assert response.status_code == 409
    assert client.get('/api/documents/' + doc['id']).status_code == 200
    assert (store.DATA / 'pdfs' / f"{doc['id']}.pdf").exists()
    with store.connect() as db:
        db.execute("UPDATE jobs SET status='stopped'")
    assert client.delete('/api/documents/' + doc['id']).status_code == 200


def test_delete_reports_locked_file_and_rejects_foreign_origin(client, monkeypatch):
    doc = upload(client)
    path = store.DATA / 'pdfs' / f"{doc['id']}.pdf"
    assert client.delete('/api/documents/' + doc['id'], headers={'origin': 'https://foreign.example'}).status_code == 403
    unlink = Path.unlink
    def locked_file(self, *args, **kwargs):
        if self == path: raise PermissionError('file in use')
        return unlink(self, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', locked_file)
    response = client.delete('/api/documents/' + doc['id'])
    assert response.status_code == 200
    assert '未能清理' in response.json()['warning']
    assert path.exists()
    assert client.get('/api/documents/' + doc['id']).status_code == 404


def test_edit_source_review_history_and_optimistic_lock(client):
    doc = upload(client); q = doc['questions'][0]; note = sample_note()
    route = f"/api/questions/{q['id']}"
    assert client.put(route + '/note', json={'note': note, 'version': 0}).status_code == 200
    assert client.put(route + '/note', json={'note': note, 'version': 0}).status_code == 409
    note['answer'] = 'B'
    assert client.put(route + '/note', json={'note': note, 'version': 1}).status_code == 200
    after = client.get('/api/documents/' + doc['id']).json()['questions'][0]
    assert after['review'] == 1 and after['manual'] == 1
    assert after['parts'][1] == 'pretext'
    revisions = client.get(route + '/history').json()
    assert len(revisions) == 3 and revisions[0]['context']['sentence'] == q['sentence']
    changed = {**q['options'], 'A': 'newword'}
    assert client.put(route + '/source', json={'number': 1, 'sentence': q['sentence'], 'options': changed, 'version': 2}).status_code == 200
    after = client.get('/api/documents/' + doc['id']).json()['questions'][0]
    assert after['note'] is None and after['original']['options']['A'] == 'premise'
    assert client.post(route + '/restore', json={'revision_id': revisions[0]['id'], 'version': 3}).status_code == 409


def test_bookmark_and_secret_boundary(client):
    doc = upload(client)
    client.put('/api/documents/' + doc['id'] + '/bookmark', json={'ordinal': 20})
    assert client.get('/api/documents/' + doc['id']).json()['bookmark'] == 20
    response = client.post('/api/documents/' + doc['id'] + '/generate', json={})
    assert response.status_code == 400
    assert 'API Key' in response.text
    assert 'api_key' not in client.get('/api/settings').json()
    assert client.put('/api/settings', json={'model': 'deepseek-flash'}, headers={'origin': 'https://foreign.example'}).status_code == 403


def prepare_job(doc, q):
    with store.connect() as db:
        db.execute('INSERT INTO jobs(id,document_id,ids,status,created_at) VALUES(?,?,?,?,?)', ('test-job', doc['id'], json.dumps([q['id']]), 'queued', store.now()))


def test_generation_saves_candidate_for_manual_edit(client, monkeypatch):
    doc = upload(client); q = doc['questions'][0]; note = sample_note()
    client.put(f"/api/questions/{q['id']}/note", json={'note': note, 'version': 0})
    prepare_job(doc, q)
    generated = copy.deepcopy(note); generated['options'][0]['meaning'] = '模型新解释'
    async def fake_call(*args): return Note.model_validate(generated)
    gen = Generator(); monkeypatch.setattr(gen, 'call', fake_call)
    asyncio.run(gen.run('test-job'))
    after = client.get('/api/documents/' + doc['id']).json()['questions'][0]
    assert after['note']['options'][0]['meaning'] != '模型新解释'
    assert after['candidate']['options'][0]['meaning'] == '模型新解释'
    accepted = client.post(f"/api/questions/{q['id']}/candidate", json={'accept': True, 'version': after['version']})
    assert accepted.status_code == 200
    after = client.get('/api/documents/' + doc['id']).json()['questions'][0]
    assert after['note']['options'][0]['meaning'] == '模型新解释'


def test_deepseek_request_and_auth_failure(client):
    doc = upload(client); q = doc['questions'][0]; prepare_job(doc, q)
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(sample_note())}, 'finish_reason': 'stop'}], 'usage': {'total_tokens': 123}})
    async def success():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as remote:
            return await Generator().call(remote, 'test-job', q, {'api_key': 'test-only', 'model': 'deepseek-flash'})
    assert asyncio.run(success()).answer == 'A'
    assert captured[0]['response_format'] == {'type': 'json_object'}
    assert json.loads(captured[0]['messages'][1]['content'])['sentence'] == q['sentence']
    async def forbidden():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(401))) as remote:
            return await Generator().call(remote, 'test-job', q, {'api_key': 'test-only', 'model': 'deepseek-flash'})
    with pytest.raises(PermanentError): asyncio.run(forbidden())


def test_restart_recovers_unfinished_tasks(client):
    doc = upload(client); q = doc['questions'][0]; prepare_job(doc, q)
    with store.connect() as db:
        db.execute("UPDATE jobs SET status='running'")
        db.execute("UPDATE questions SET status='generating' WHERE id=?", (q['id'],))
    store.init()
    after = client.get('/api/documents/' + doc['id']).json()
    assert after['questions'][0]['status'] == 'ready'
    assert after['job']['status'] == 'interrupted'


def test_invalid_model_response_retries_then_succeeds(client, monkeypatch):
    doc = upload(client); q = doc['questions'][0]; prepare_job(doc, q)
    attempts = []
    async def no_delay(_): pass
    monkeypatch.setattr('backend.generation.asyncio.sleep', no_delay)
    def handler(request):
        attempts.append(1)
        raw = '{}' if len(attempts) < 3 else json.dumps(sample_note())
        return httpx.Response(200, json={'choices': [{'message': {'content': raw}, 'finish_reason': 'stop'}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as remote:
            return await Generator().call(remote, 'test-job', q, {'api_key': 'test-only', 'model': 'deepseek-flash'})
    assert asyncio.run(run()).answer == 'A'
    assert len(attempts) == 3
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM calls WHERE status=?', ('error',)).fetchone()[0] == 2


def test_generated_note_and_stopped_job_preserve_existing_data(client, monkeypatch):
    doc = upload(client); q = doc['questions'][0]; prepare_job(doc, q)
    async def fake_call(*args): return Note.model_validate(sample_note())
    gen = Generator(); monkeypatch.setattr(gen, 'call', fake_call)
    asyncio.run(gen.run('test-job'))
    result = client.get('/api/documents/' + doc['id']).json()
    assert result['questions'][0]['note']['answer'] == 'A'
    assert result['questions'][0]['manual'] == 0
    assert result['job']['status'] == 'completed'
    with store.connect() as db:
        db.execute("UPDATE jobs SET status='queued',stop=1")
        db.execute("UPDATE questions SET status='queued' WHERE id=?", (q['id'],))
    asyncio.run(gen.run('test-job'))
    after = client.get('/api/documents/' + doc['id']).json()
    assert after['questions'][0]['note'] == result['questions'][0]['note']
    assert after['questions'][0]['status'] == 'done'
    assert after['job']['status'] == 'stopped'
