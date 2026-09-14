import hashlib
import json
import os
import subprocess
import threading
from functools import lru_cache

from . import store

_lock = threading.Lock()


def _powershell(mode, output=None, payload=None):
    command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
               str(store.ROOT / 'backend' / 'windows_speech.ps1'), '-Mode', mode]
    if output:
        command += ['-OutputFile', str(output)]
    result = subprocess.run(command, input=json.dumps(payload, ensure_ascii=False) if payload else '',
        capture_output=True, text=True, encoding='utf-8', timeout=35,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError('本机英语语音暂不可用，请检查系统语音设置')
    return result.stdout.lstrip('\ufeff').strip()


@lru_cache(maxsize=1)
def voices():
    if os.name != 'nt':
        return []
    try:
        result = json.loads(_powershell('voices'))
        return result if isinstance(result, list) else []
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
        return []


def synthesize(text, voice, rate):
    if voice not in {v['name'] for v in voices()}:
        raise ValueError('请选择可用的本机英语音色')
    directory = store.DATA / 'audio'
    directory.mkdir(exist_ok=True)
    key = hashlib.sha256(store.dump([text, voice, rate]).encode('utf-8')).hexdigest()
    output = directory / f'{key}.wav'
    with _lock:
        if not output.exists():
            temp = directory / f'{key}.tmp.wav'
            try:
                _powershell('synthesize', temp, {'text': text, 'voice': voice, 'rate': rate})
                temp.replace(output)
            finally:
                temp.unlink(missing_ok=True)
    return output
