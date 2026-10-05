"""Exercise scheduling and forwarding without contacting Telegram."""

import asyncio
import json
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation_worker as worker


class FakeClient:
    instances = []
    sent = []
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
        self.sent.append((target, message))

    async def forward_messages(self, target, message):
        self.forwarded.append((target, message))

    async def disconnect(self):
        pass


async def exercise():
    fake = types.ModuleType("telethon")
    fake.TelegramClient = FakeClient
    fake.events = types.SimpleNamespace(NewMessage=lambda **kwargs: kwargs)
    sys.modules["telethon"] = fake
    with tempfile.TemporaryDirectory(prefix="autocheckin-worker-") as directory:
        worker.CONFIG_PATH = Path(directory) / "config.json"
        worker.STATE_PATH = Path(directory) / ".automation-state.json"
        now = worker.dt.datetime.now(worker.CHINA_TIME)
        config = {
            "telegram": {"users": [{"name": "test", "session": "test", "api_id": 123, "api_hash": "dummy"}]},
            "automations": {
                "schedules": [{"id": "schedule_test", "enabled": True, "account": "test", "target": "@target_group", "repeat": "once", "time": now.strftime("%Y-%m-%dT%H:%M"), "message": "hello"}],
                "forwards": [{"id": "forward_test", "enabled": True, "account": "test", "source": "@source_group", "target": "@target_group"}],
            },
        }
        worker.CONFIG_PATH.write_text(json.dumps(config), encoding="utf-8")
        task = asyncio.create_task(worker.main())
        try:
            await asyncio.sleep(0.1)
            assert FakeClient.sent == [("@target_group", "hello")]
            assert len(FakeClient.instances[0].handlers) == 1
            await FakeClient.instances[0].handlers[0](types.SimpleNamespace(message="new post"))
            await asyncio.sleep(0.05)
            assert FakeClient.forwarded == [("@target_group", "new post")]
            assert len(json.loads(worker.STATE_PATH.read_text(encoding="utf-8"))["sent"]) == 1
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


asyncio.run(exercise())
print("定时发送、转发和去重状态检查通过")
