"""Account-scoped JSON output for the web runner; CLI output stays readable."""
import contextlib
import contextvars
import json
import os
import sys

_account = contextvars.ContextVar('checkin_account', default=None)
_sink = None


def emit_result(account, completed):
    if _sink is not None:
        _sink.write(json.dumps({'type':'account_result', 'account':account,
                                'state':'completed' if completed else 'failed'}, ensure_ascii=False) + '\n')
        _sink.flush()


class ScopedOutput:
    def __init__(self, sink, stream):
        self.sink, self.stream = sink, stream
        self.buffers = {}

    def write(self, text):
        account = _account.get()
        buffer = self.buffers.get(account, '') + text
        while '\n' in buffer or len(buffer) > 2000:
            boundary = buffer.find('\n')
            if 0 <= boundary <= 2000:
                line, buffer = buffer[:boundary], buffer[boundary + 1:]
            else:
                line, buffer = buffer[:2000], buffer[2000:]
            self.emit(account, line.rstrip('\r'))
        self.buffers[account] = buffer
        return len(text)

    def emit(self, account, text):
        if text:
            self.sink.write(json.dumps({'type':'checkin_log', 'account':account,
                'stream':self.stream, 'text':text}, ensure_ascii=False) + '\n')
            self.sink.flush()

    def flush(self):
        account = _account.get()
        self.emit(account, self.buffers.pop(account, ''))
        self.sink.flush()

    def __getattr__(self, name):
        return getattr(self.sink, name)


@contextlib.contextmanager
def account_log(account):
    token = _account.set(account)
    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        _account.reset(token)


def install_json_output():
    global _sink
    if os.environ.get('AUTOCHECKIN_LOG_JSON') == '1' and _sink is None:
        _sink = sys.stdout
        sys.stdout = ScopedOutput(_sink, 'stdout')
        sys.stderr = ScopedOutput(_sink, 'stderr')
