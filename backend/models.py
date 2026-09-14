import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Letter = Literal['A', 'B', 'C', 'D']


def speech_text(text: str) -> str:
    text = re.sub(r'\bsb\b\.?', 'somebody', text, flags=re.I)
    text = re.sub(r'\bsth\b\.?', 'something', text, flags=re.I)
    return re.sub(r'\.{2,}|…', '', text).strip()


def expand_phrase(text: str) -> list[str]:
    # Expand only the slash-connected words, retaining their shared context.
    match = re.search(r"[A-Za-z][A-Za-z'-]*(?:/[A-Za-z][A-Za-z'-]*)+", text)
    if not match:
        return [text.strip()]
    result = []
    for word in match.group().split('/'):
        result.extend(expand_phrase(text[:match.start()] + word + text[match.end():]))
    return list(dict.fromkeys(result))[:16]


class Phrase(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')
    text: str = Field(min_length=1, max_length=250)
    speak: str = ''

    @model_validator(mode='after')
    def normalize(self):
        self.speak = speech_text(self.text)
        return self


class Explanation(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')
    label: Letter
    pos: str = Field(min_length=1, max_length=40)
    meaning: str = Field(min_length=1, max_length=600)
    collocations: list[Phrase] = Field(min_length=1, max_length=16)
    reason: str = Field(default='', max_length=1200)

    @field_validator('collocations')
    @classmethod
    def expand(cls, phrases):
        seen = set()
        result = []
        for phrase in phrases:
            for text in expand_phrase(phrase.text):
                if text not in seen:
                    seen.add(text)
                    result.append(Phrase(text=text))
        return result[:16]


class Note(BaseModel):
    model_config = ConfigDict(extra='forbid')
    answer: Letter
    options: list[Explanation] = Field(min_length=4, max_length=4)
    uncertainty: str = Field(default='', max_length=1000)

    @model_validator(mode='after')
    def labels(self):
        if sorted(o.label for o in self.options) != list('ABCD'):
            raise ValueError('必须包含互不重复的 A、B、C、D 四项解析')
        self.options.sort(key=lambda o: o.label)
        return self


def missing_explanations(note: dict | None) -> list[str]:
    if not note:
        return []
    return [o['label'] for o in note.get('options', []) if len(o.get('reason', '').strip()) < 8]


class CompleteNote(Note):
    @model_validator(mode='after')
    def require_explanations(self):
        missing = missing_explanations(self.model_dump())
        if missing:
            raise ValueError('每个选项都必须有针对本题的简要解释，至少 8 个字符；缺少：' + '、'.join(missing))
        return self


def filled_parts(sentence: str, options: dict[str, str], answer: str | None):
    blanks = list(re.finditer(r'_{2,}', sentence))
    if len(blanks) != 1 or answer not in options:
        return [sentence, '', '']
    blank = blanks[0]
    before, after = sentence[:blank.start()], sentence[blank.end():]
    # A PDF can place the blank directly against a word (e.g. ______of).
    if before and before[-1].isalnum():
        before += ' '
    if after and after[0].isalnum():
        after = ' ' + after
    return [before, options[answer], after]
