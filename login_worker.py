#!/usr/bin/env python3
"""Dedicated, bounded QR authorization worker; JSON only, no check-in imports."""
from telegram_credentials import resolve_credentials
from outgoing_proxy import telegram_proxy_kwargs, install_network_guard
import asyncio
import base64
import io
import json
import os
import re
import signal
import sqlite3
import sys
from pathlib import Path
from account_profile import save_profile
from storage import read_document, parse_config_text


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


_reader = None
_transport = None


def emit_error(error, phase, *, proxy_enabled=False):
    """Send fixed diagnostic codes only; RPC exceptions may contain login tokens."""
    name = type(error).__name__
    fields = {}
    if isinstance(error, ImportError) or phase == 'dependencies':
        code = 'dependency_missing'
    elif name in {'ApiIdInvalidError', 'ConnectionApiIdInvalidError'}:
        code = 'api_invalid'
    elif name == 'ApiIdPublishedFloodError':
        code = 'api_restricted'
    elif name in {'FloodWaitError', 'FloodPremiumWaitError'}:
        code = 'rate_limited'
        seconds = getattr(error, 'seconds', None)
        if isinstance(seconds, int) and not isinstance(seconds, bool) and 0 < seconds <= 2147483647:
            fields['retryAfterSeconds'] = seconds
    elif name == 'PasswordHashInvalidError':
        code = 'password_invalid'
    elif name in {'AuthTokenExpiredError', 'AuthTokenInvalidError', 'AuthTokenAlreadyAcceptedError'}:
        code = 'qr_expired'
    elif name in {'UserDeactivatedError', 'UserDeactivatedBanError', 'PhoneNumberBannedError'}:
        code = 'account_unavailable'
    elif name in {'AuthKeyDuplicatedError', 'AuthKeyUnregisteredError', 'SessionRevokedError', 'SessionExpiredError'}:
        code = 'session_invalid'
    elif isinstance(error, PermissionError):
        code = 'storage_permission'
    elif isinstance(error, sqlite3.OperationalError) and 'locked' in str(error).lower():
        code = 'session_busy'
    elif isinstance(error, sqlite3.DatabaseError):
        code = 'session_storage'
    elif type(error).__module__.startswith('psycopg'):
        code = 'config_unavailable'
    elif phase == 'credentials':
        code = 'credentials_missing'
    elif phase == 'proxy':
        code = 'proxy_config'
    elif phase == 'configuration':
        code = 'config_unavailable'
    elif phase == 'qr_image':
        code = 'qr_render_failed'
    elif isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        code = 'password_timeout' if phase == 'password_input' else 'qr_timeout' if phase == 'scan' else 'proxy_unreachable' if proxy_enabled else 'connection_timeout'
    elif isinstance(error, (ConnectionError, OSError, asyncio.IncompleteReadError)):
        code = 'proxy_unreachable' if proxy_enabled else 'network_error'
    elif name in {'ServerError', 'RpcCallFailError', 'TimedOutError'}:
        code = 'telegram_unavailable'
    else:
        code = 'unknown'
    emit('error', code=code, phase=phase, **fields)


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


async def login(account, data_dir, *, client_factory=None, password_reader=read_password, profile_only=False):
    phase, client, proxy_enabled = 'dependencies', None, False
    try:
        from telethon import TelegramClient
        from telethon.errors import SessionPasswordNeededError, PasswordHashInvalidError
        import qrcode
        phase = 'configuration'
        emit('progress', phase=phase)
        if not re.fullmatch(r"[\w.-]+", account) or account in (".", ".."):
            raise ValueError("invalid session")
        config = read_document('config', Path(data_dir) / 'config.json', parser=parse_config_text)
        users = config.get("telegram", {}).get("users", config.get("users", []))
        user = next(u for u in users if (u.get("session") or u.get("name")) == account)
        phase = 'credentials'
        api_id, api_hash = resolve_credentials(config, user)
        phase = 'proxy'
        proxy_options = telegram_proxy_kwargs(user)
        proxy_enabled = bool(proxy_options)
        phase = 'session'
        client = (client_factory or TelegramClient)(str(Path(data_dir) / account), api_id, api_hash,
            device_model="AutoCheckin", connection_retries=1, request_retries=1, retry_delay=1,
            timeout=10, flood_sleep_threshold=0, **proxy_options)
        phase = 'connect'
        emit('progress', phase=phase)
        await asyncio.wait_for(client.connect(), 30)
        phase = 'authorization'
        emit('progress', phase=phase)
        if not await asyncio.wait_for(client.is_user_authorized(), 20):
            if profile_only:
                emit('error', code='login_required', phase=phase)
                return 2
            for _ in range(6):
                phase = 'qr'
                emit('progress', phase=phase)
                qr = await asyncio.wait_for(client.qr_login(), 20)
                phase = 'qr_image'
                image = io.BytesIO()
                qrcode.make(qr.url).save(image, format="PNG")
                emit("QR", png=base64.b64encode(image.getvalue()).decode("ascii"), expiresAt=qr.expires.isoformat())
                phase = 'scan'
                try:
                    from datetime import datetime, timezone
                    remaining = (qr.expires - datetime.now(timezone.utc)).total_seconds()
                    await qr.wait(timeout=min(60, max(1, remaining)))
                    break
                except asyncio.TimeoutError:
                    continue
                except SessionPasswordNeededError:
                    for attempt in range(3):
                        phase = 'password_input'
                        emit("password_required", invalid=attempt > 0)
                        password = await password_reader()
                        try:
                            phase = 'password'
                            await asyncio.wait_for(client.sign_in(password=password), 20)
                            break
                        except PasswordHashInvalidError:
                            if attempt == 2:
                                raise
                        finally:
                            password = None
                    break
            phase = 'authorization'
            if not await asyncio.wait_for(client.is_user_authorized(), 20):
                emit('error', code='qr_timeout', phase='scan')
                return 2
        phase = 'profile'
        try:
            await asyncio.wait_for(save_profile(client, account, data_dir), 25)
        except Exception as error:
            if profile_only:
                emit_error(error, phase, proxy_enabled=proxy_enabled)
                return 2
            # Authorization remains successful if fetching display data fails.
        emit("success")
        return 0
    except Exception as error:
        emit_error(error, phase, proxy_enabled=proxy_enabled)
        return 2
    finally:
        if client:
            try:
                await asyncio.wait_for(client.disconnect(), 10)
            except Exception:
                # Cleanup errors must not replace a completed authorization result.
                pass


async def main():
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, task.cancel)
        except NotImplementedError:
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(task.cancel))
    try:
        emit('progress', phase='proxy')
        install_network_guard()
    except Exception as error:
        emit_error(error, 'proxy')
        return 2
    try:
        return await asyncio.wait_for(login(sys.argv[1], os.environ.get("AUTOCHECKIN_DATA_DIR") or Path(__file__).resolve().parent, profile_only='--profile-only' in sys.argv[2:]), 480)
    except asyncio.CancelledError:
        return 0
    except asyncio.TimeoutError:
        emit('error', code='login_timeout')
        return 2
    except Exception as error:
        emit_error(error, 'startup')
        return 2
    finally:
        if _transport:
            _transport.close()


if __name__ == "__main__":
    os.umask(0o077)
    sys.exit(asyncio.run(main()))
