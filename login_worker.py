#!/usr/bin/env python3
"""Dedicated, bounded QR authorization worker; JSON only, no check-in imports."""
import asyncio
import base64
import io
import json
import os
import re
import signal
import sys
from pathlib import Path
from automation_worker import parse_config_text


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


_reader = None
_transport = None


async def read_password():
    # Reuse one pipe across wrong-password retries; no blocking input thread.
    global _reader, _transport
    if _reader is None:
        _reader = asyncio.StreamReader(limit=4096)
        protocol = asyncio.StreamReaderProtocol(_reader)
        _transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    line = await asyncio.wait_for(_reader.readline(), 120)
    data = json.loads(line)
    password = data.get("password")
    if not isinstance(password, str) or not 1 <= len(password) <= 256:
        raise ValueError("invalid password")
    return password


async def login(account, data_dir, *, client_factory=None, password_reader=read_password):
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError, PasswordHashInvalidError
    import qrcode
    if not re.fullmatch(r"[\w.-]+", account) or account in (".", ".."):
        raise ValueError("invalid session")
    config = parse_config_text((Path(data_dir) / "config.json").read_text(encoding="utf-8"))
    users = config.get("telegram", {}).get("users", config.get("users", []))
    user = next(u for u in users if (u.get("session") or u.get("name")) == account)
    client = (client_factory or TelegramClient)(str(Path(data_dir) / account), int(user["api_id"]), user["api_hash"], device_model="AutoCheckin Web")
    try:
        await asyncio.wait_for(client.connect(), 30)
        if not await client.is_user_authorized():
            for _ in range(6):
                qr = await client.qr_login()
                image = io.BytesIO()
                qrcode.make(qr.url).save(image, format="PNG")
                emit("QR", png=base64.b64encode(image.getvalue()).decode("ascii"), expiresAt=qr.expires.isoformat())
                try:
                    await qr.wait(timeout=60)
                    break
                except asyncio.TimeoutError:
                    continue
                except SessionPasswordNeededError:
                    for attempt in range(3):
                        emit("password_required", invalid=attempt > 0)
                        password = await password_reader()
                        try:
                            await client.sign_in(password=password)
                            break
                        except PasswordHashInvalidError:
                            if attempt == 2:
                                raise
                        finally:
                            password = None
                    break
            if not await client.is_user_authorized():
                emit("error", message="登录超时，请重试")
                return 2
        emit("success")
        return 0
    finally:
        await asyncio.wait_for(client.disconnect(), 10)


async def main():
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    try:
        return await asyncio.wait_for(login(sys.argv[1], os.environ.get("AUTOCHECKIN_DATA_DIR") or Path(__file__).resolve().parent), 480)
    except asyncio.CancelledError:
        return 0
    except Exception:
        # Telegram errors can contain credential/token material: never serialize them.
        emit("error", message="登录失败或超时，请检查 API 凭据、网络并重试")
        return 2
    finally:
        if _transport:
            _transport.close()


if __name__ == "__main__":
    os.umask(0o077)
    sys.exit(asyncio.run(main()))
