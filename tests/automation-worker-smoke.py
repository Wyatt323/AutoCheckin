"""Exercise scheduling and forwarding without contacting Telegram."""

import asyncio
import contextlib
import io
import json
import sys
import tempfile
import types
from pathlib import Path

from offline_support import TEMP_ROOT

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation_worker as worker


class FakeClient:
    instances = []
    sent = []
    read = []
    forwarded = []

    def __init__(self, *args, **kwargs):
        self.handlers = []
        self.instances.append(self)

    async def connect(self):
        pass

    async def is_user_authorized(self):
        return True

    async def get_input_entity(self, chat):
        return chat

    def add_event_handler(self, handler, event):
        self.handlers.append(handler)

    async def send_message(self, target, message):
        if target == '@send_failed':
            raise RuntimeError('offline send failure')
        self.sent.append((target, message))

    async def send_read_acknowledge(self, target):
        self.read.append(target)
        if target == '@read_failed':
            raise RuntimeError('offline read failure')

    async def forward_messages(self, target, message):
        self.forwarded.append((target, message))

    async def disconnect(self):
        pass


async def exercise():
    fake = types.ModuleType("telethon")
    fake.TelegramClient = FakeClient
    fake.events = types.SimpleNamespace(NewMessage=lambda **kwargs: kwargs)
    sys.modules["telethon"] = fake
    with tempfile.TemporaryDirectory(dir=TEMP_ROOT, prefix="autocheckin-worker-") as directory:
        worker.CONFIG_PATH = Path(directory) / "config.json"
        worker.STATE_PATH = Path(directory) / ".automation-state.json"
        now = worker.dt.datetime.now(worker.CHINA_TIME)
        config = {
            "telegram": {"users": [{"name": "test", "session": "test", "api_id": 123, "api_hash": "dummy"}]},
            "automations": {
                "schedules": [{"id": rule_id, "enabled": True, "account": "test", "target": target, "repeat": "once", "time": now.strftime("%Y-%m-%dT%H:%M"), "message": "hello"} for rule_id, target in [('schedule_test', '@target_group'), ('schedule_read_failed', '@read_failed'), ('schedule_send_failed', '@send_failed')]],
                "forwards": [{"id": "forward_test", "enabled": True, "account": "test", "source": "@source_group", "target": "@target_group"}],
            },
        }
        worker.CONFIG_PATH.write_text(json.dumps(config), encoding="utf-8")
        task = asyncio.create_task(worker.main())
        try:
            await asyncio.sleep(0.1)
            assert FakeClient.sent == [("@target_group", "hello"), ("@read_failed", "hello")]
            assert FakeClient.read == ["@target_group", "@read_failed"]
            assert len(FakeClient.instances[0].handlers) == 1
            await FakeClient.instances[0].handlers[0](types.SimpleNamespace(message="new post"))
            await asyncio.sleep(0.05)
            assert FakeClient.forwarded == [("@target_group", "new post")]
            assert len(json.loads(worker.STATE_PATH.read_text(encoding="utf-8"))["sent"]) == 2
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # A failed read receipt must not cause a message to be resent after restart.
        task = asyncio.create_task(worker.main())
        try:
            await asyncio.sleep(0.1)
            assert FakeClient.sent == [("@target_group", "hello"), ("@read_failed", "hello")]
            assert FakeClient.read == ["@target_group", "@read_failed"]
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


output = io.StringIO()
with contextlib.redirect_stdout(output):
    asyncio.run(exercise())
events = [json.loads(line) for line in output.getvalue().splitlines()]
message = next(event for event in events if event.get('category') == 'message')
forward = next(event for event in events if event.get('category') == 'forward' and '已转发' in event['message'])
assert message['account'] == forward['account'] == 'test'
assert message['ruleId'] == 'schedule_test' and forward['ruleId'] == 'forward_test'
assert message['state'] == forward['state'] == 'completed'
assert '会话已标记为已读' in message['message']
read_failed = next(event for event in events if event.get('ruleId') == 'schedule_read_failed')
assert read_failed['level'] == 'warning' and read_failed['state'] == 'completed'
assert '已发送' in read_failed['message'] and '标记已读失败' in read_failed['message']
send_failed = next(event for event in events if event.get('ruleId') == 'schedule_send_failed')
assert send_failed['level'] == 'error' and send_failed['state'] == 'failed'
print("定时发送后已读、已读失败不重发、发送失败、转发和去重状态检查通过")
