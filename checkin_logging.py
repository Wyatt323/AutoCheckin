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
    if _sink is not None:
        _sink.write(json.dumps({"type": "bot_result", "account": account, "bot": str(bot),
                               "name": name, "note": note, "status": status, "result": result},
                              ensure_ascii=False) + "\n")
        _sink.flush()
    else:
        label = f"{note}（{name}）" if note else name
        prefix = {"success": "✅", "already": "✅", "timeout": "⏰", "failed": "❌",
                  "skipped": "⏭️", "unknown": "⚠️"}[status]
        suffix = {"already": "已签到", "timeout": "超时", "failed": "失败",
                  "skipped": "无签到方式，跳过", "unknown": "结果未确认"}.get(status)
        print(f"  {prefix} {label}" + (f"：{suffix}" if suffix else ""))


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
