"""Verify legacy Bot migration and per-account signing selection without Telegram."""

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from offline_support import TEMP_ROOT

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import allinone

sys.stdout.reconfigure(encoding="utf-8")


def config(users):
    return {
        "telegram": {"users": users, "dialog_folder": "legacy-folder"},
        "ai": {"model": "mock", "providers": [{"name": "mock", "base_url": "https://example.com", "api_key": "dummy"}]},
        "bot_groups": {"button": ["@legacy_bot"], "command": []},
        "bot_notes": {"@legacy_bot": "legacy note"},
    }


with tempfile.TemporaryDirectory(dir=TEMP_ROOT, prefix="autocheckin-accounts-") as directory:
    file = Path(directory) / "config.json"
    users = [
        {"name": "first", "session": "first", "api_id": 1, "api_hash": "dummy"},
        {"name": "second", "session": "second", "api_id": 2, "api_hash": "dummy"},
    ]
    file.write_text(json.dumps(config(users)), encoding="utf-8")
    allinone.DATA_DIR = Path(directory)
    assert len(allinone.load_config()[2]) == 2
    _, _, normalized = allinone.load_config(file)
    assert [user["bots"] for user in normalized] == [["@legacy_bot"], ["@legacy_bot"]]
    assert normalized[0]["bot_notes"] == {"@legacy_bot": "legacy note"}

    users[0]["bot_groups"] = {"button": [], "command": [{"bot": "@first_bot", "command": "/checkin"}]}
    users[0]["dialog_folder"] = "first-folder"
    users[0]["bot_notes"] = {"@first_bot": "牛逼"}
    users[1]["bot_groups"] = {"button": ["@second_bot"], "command": []}
    file.write_text(json.dumps(config(users)), encoding="utf-8")
    loaded = allinone.load_config(file)
    first, second = loaded[2]
    assert first["bots"] == ["@first_bot"]
    assert first["bot_commands"] == {"@first_bot": "/checkin"}
    assert first["dialog_folder"] == "first-folder"
    assert first["bot_notes"] == {"@first_bot": "牛逼"}
    assert second["bot_notes"] == {}, "account Bot list must not inherit other Bot remarks"
    assert second["bots"] == ["@second_bot"]

    calls = []

    async def fake_run_user(user, model, clients, bots, commands, folder):
        calls.append((user["name"], bots, folder))
        return user["name"] != "first"

    allinone.load_config = lambda: loaded
    allinone.build_ai_clients = lambda providers: [("mock", object())]
    allinone.run_user = fake_run_user
    async def no_wait(*args): pass
    allinone.asyncio.sleep = no_wait
    asyncio.run(allinone.main())
    assert calls == [("first", ["@first_bot"], "first-folder"), ("second", ["@second_bot"], "legacy-folder")]
    calls.clear()
    asyncio.run(allinone.main("second"))
    assert calls == [("second", ["@second_bot"], "legacy-folder")]

print("旧配置兼容、账号独立 Bot 与失败后继续下一个账号检查通过")
