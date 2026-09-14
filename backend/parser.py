import re
from pathlib import Path

import pdfplumber
from markdown_it import MarkdownIt

from .models import Note, Phrase


def issues_for(sentence: str, options: dict[str, str]) -> list[str]:
    issues = []
    if len(re.findall(r'_{2,}', sentence)) != 1:
        issues.append('题干需要有且只有一处下划线填空')
    if set(options) != set('ABCD') or any(not v.strip() for v in options.values()):
        issues.append('需要完整的 A-D 四个选项')
    if len(sentence.strip()) < 10:
        issues.append('题干过短，请对照原文')
    return issues


def parse_pages(pages: list[str]) -> dict:
    blocks = []
    current = None
    title = ''
    for page, text in enumerate(pages, 1):
        for line in text.splitlines():
            line = line.strip()
            match = re.match(r'^(\d{1,4})[.．、]\s*(.+)', line)
            if match:
                if current:
                    blocks.append(current)
                current = {'number': int(match[1]), 'page': page, 'lines': [match[2]]}
            elif current and line and not re.fullmatch(r'(?:第\s*)?\d+\s*(?:页)?', line):
                if line != title:
                    current['lines'].append(line)
            elif not current and line and not title:
                title = line
    if current:
        blocks.append(current)
    questions = []
    seen = set()
    expected = 1
    for block in blocks:
        text = ' '.join(block['lines'])
        matches = list(re.finditer(r'(?<!\w)([ABCD])[)）]\s*', text))
        options = {}
        for idx, match in enumerate(matches):
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
            options[match[1]] = text[match.end():end].strip()
        sentence = text[:matches[0].start()].strip() if matches else text
        issues = issues_for(sentence, options)
        if len(matches) != 4:
            issues.append('选项标记数量异常')
        if block['number'] in seen:
            issues.append('题号重复')
        if block['number'] != expected:
            issues.append(f'题号不连续，预期为 {expected}')
        seen.add(block['number'])
        expected = block['number'] + 1
        questions.append({
            'number': block['number'], 'page': block['page'], 'sentence': sentence,
            'options': options, 'issues': issues, 'raw': text,
        })
    warnings = []
    if not questions:
        warnings.append('未识别到词汇选择题。请使用可复制文字、带题号和 A-D 选项的 PDF。')
    if not any(t.strip() for t in pages):
        warnings = ['此 PDF 没有可读取的文字层，第一版暂不支持扫描件。']
    return {'title': title, 'pages': len(pages), 'questions': questions, 'warnings': warnings}


def parse_pdf(path: Path) -> dict:
    with pdfplumber.open(path) as pdf:
        if len(pdf.pages) > 200:
            raise ValueError('单份 PDF 最多支持 200 页')
        return parse_pages([page.extract_text(x_tolerance=2) or '' for page in pdf.pages])


def read_existing_notes(path: Path, enrich=True) -> dict[int, Note]:
    tokens = MarkdownIt().parse(path.read_text(encoding='utf-8-sig'))
    entries = {}
    number = None
    for token in tokens:
        if token.type != 'inline':
            continue
        children = token.children or []
        text = ''.join(t.content for t in children if t.type in ('text', 'code_inline', 'softbreak'))
        head = re.match(r'^(\d+)\.', text)
        if head:
            number = int(head[1])
            answer = re.search(r'答案：\s*([ABCD])', text)
            entries[number] = {'answer': answer[1] if answer else None, 'options': []}
        elif number and re.match(r'^[ABCD]\)', text):
            label = text[0]
            explanation = text.split('：', 1)[-1]
            definition = explanation.split('搭配：', 1)[0].strip().rstrip('。')
            pos = re.match(r'^([a-z./]+\.)\s*(.*)', definition)
            phrases = [Phrase(text=t.content) for t in children if t.type == 'code_inline']
            last_code = max((i for i, t in enumerate(children) if t.type == 'code_inline'), default=-1)
            reason = ''.join(t.content for t in children[last_code + 1:] if t.type == 'text').strip('。 /')
            entries[number]['options'].append({
                'label': label, 'pos': pos[1] if pos else '短语',
                'meaning': pos[2] if pos else definition,
                'collocations': [p.model_dump() for p in phrases] or [{'text': text.split('：')[0][3:].strip()}],
                'reason': reason.replace('✅', '').strip(),
            })
    result = {}
    for number, entry in entries.items():
        try:
            note = Note.model_validate(entry)
            series = re.fullmatch(r'词汇练习笔记([12])', path.stem)
            if enrich and series:
                from .enrichment import enrich_sample
                note = enrich_sample(note, series[1], number)
            result[number] = note
        except ValueError:
            continue
    return result
