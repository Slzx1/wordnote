import socket
import os
import threading
import webbrowser

import uvicorn

from .store import ROOT


def main():
    if not (ROOT / 'dist' / 'index.html').exists():
        raise SystemExit('Frontend is missing. Run start.cmd to install and build it.')
    for port in range(8765, 8800):
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
                break
            except OSError:
                continue
    else:
        raise SystemExit('No free port found between 8765 and 8799.')
    url = f'http://127.0.0.1:{port}'
    print(f'Wordnote: {url}', flush=True)
    if not os.environ.get('WORDNOTE_NO_BROWSER'):
        threading.Timer(2, lambda: webbrowser.open(url)).start()
    uvicorn.run('backend.app:app', host='127.0.0.1', port=port)


if __name__ == '__main__':
    main()
