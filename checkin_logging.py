"""Account-scoped JSON output for the web runner; CLI output stays readable."""
import contextlib
import contextvars
import json
import os
import sys

_account = contextvars.ContextVar('checkin_account', default=None)
_emitter = contextvars.ContextVar('checkin_emitter', default=None)
_sink = None


def write_raw(event):
    sink = _sink or sys.stdout
    sink.write(json.dumps(event, ensure_ascii=False) + '\n')
    sink.flush()


def write_event(event):
    emitter = _emitter.get()
    if emitter is not None:
        emitter(event)
    elif _sink is not None:
        write_raw(event)


@contextlib.contextmanager
def output_to(emitter):
    token = _emitter.set(emitter)
    try:
        yield
    finally:
        _emitter.reset(token)


def log_context():
    return _account.get(), _emitter.get()


def emit_health(message='', kind='health', **metadata):
    write_event({'type': kind, **metadata})


def emit_result(account, completed):
    write_event({'type':'account_result', 'account':account,
                 'state':'completed' if completed else 'failed'})


def result_status(result):
    if "已签到" in result:
        return "already"
    if "签到成功" in result or "签到完成" in result or "打卡成功" in result:
        return "success"
    if "超时" in result:
        return "timeout"
    if "无签到方式" in result or "跳过" in result:
        return "skipped"
    if "失败" in result or "错误" in result:
        return "failed"
    return "unknown"


def emit_bot_result(account, bot, name, note, result):
    status = result_status(result)
    if _sink is not None or _emitter.get() is not None:
        write_event({"type": "bot_result", "account": account, "bot": str(bot),
                     "name": name, "note": note, "status": status, "result": result})
    else:
        label = f"{note}（{name}）" if note else name
        prefix = {"success": "✅", "already": "✅", "timeout": "⏰", "failed": "❌",
                  "skipped": "⏭️", "unknown": "⚠️"}[status]
        suffix = {"already": "已签到", "timeout": "超时", "failed": "失败",
                  "skipped": "无签到方式，跳过", "unknown": "结果未确认"}.get(status)
        print(f"  {prefix} {label}" + (f"：{suffix}" if suffix else ""))


class ScopedOutput:
    def __init__(self, sink, stream, passthrough=False):
        self.sink, self.stream = sink, stream
        self.passthrough = passthrough
        self.buffers = {}

    def write(self, text):
        if self.passthrough and _emitter.get() is None:
            return self.sink.write(text)
        account = _account.get()
        key = (account, _emitter.get())
        buffer = self.buffers.get(key, '') + text
        while '\n' in buffer or len(buffer) > 2000:
            boundary = buffer.find('\n')
            if 0 <= boundary <= 2000:
                line, buffer = buffer[:boundary], buffer[boundary + 1:]
            else:
                line, buffer = buffer[:2000], buffer[2000:]
            self.emit(account, line.rstrip('\r'))
        if buffer:
            self.buffers[key] = buffer
        else:
            self.buffers.pop(key, None)
        return len(text)

    def emit(self, account, text):
        if text:
            event = {'type':'checkin_log', 'account':account, 'stream':self.stream, 'text':text}
            emitter = _emitter.get()
            if emitter is not None:
                emitter(event)
            else:
                self.sink.write(json.dumps(event, ensure_ascii=False) + '\n')
                self.sink.flush()

    def flush(self):
        account = _account.get()
        self.emit(account, self.buffers.pop((account, _emitter.get()), ''))
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


def install_json_output(passthrough=False):
    global _sink
    if (passthrough or os.environ.get('AUTOCHECKIN_LOG_JSON') == '1') and _sink is None:
        _sink = sys.stdout
        sys.stdout = ScopedOutput(_sink, 'stdout', passthrough)
        sys.stderr = ScopedOutput(sys.stderr if passthrough else _sink, 'stderr', passthrough)
