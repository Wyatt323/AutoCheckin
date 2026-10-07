"""Resolve group/channel names using an in-memory copy of the account's authorization.

The existing Telethon SQLite Session is opened read-only and never upgraded/written.
This allows metadata queries while the automation process owns the file.
"""
import asyncio
import json
import os
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

from storage import read_document
from automation_worker import parse_config_text
from telegram_credentials import resolve_credentials


def normalize_peer(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 120:
        raise ValueError('invalid peer')
    value = value.strip()
    if re.fullmatch(r'-?\d{1,20}', value):
        return int(value)
    match = re.fullmatch(r'https://t\.me/([A-Za-z0-9_]{5,32})/?', value, re.I)
    if match:
        return '@' + match[1]
    if re.fullmatch(r'@?[A-Za-z][A-Za-z0-9_]{4,31}', value):
        return '@' + value.lstrip('@')
    raise ValueError('invalid peer')


def authorization_snapshot(session_file):
    from telethon.sessions import MemorySession
    from telethon.crypto import AuthKey
    with closing(sqlite3.connect(session_file.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
        row = db.execute('SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1').fetchone()
        if not row or not row[3]:
            raise ValueError('not authorized')
        session = MemorySession()
        session.set_dc(row[0], row[1], row[2])
        session.auth_key = AuthKey(data=row[3])
    return session


def cached_numeric_peer(session_file, peer_id):
    from telethon import types, utils
    with closing(sqlite3.connect(session_file.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
        row = db.execute('SELECT hash FROM entities WHERE id = ?', (peer_id,)).fetchone()
    if not row:
        return peer_id
    entity_id, kind = utils.resolve_id(peer_id)
    if kind == types.PeerChannel:
        return types.InputPeerChannel(entity_id, row[0])
    if kind == types.PeerChat:
        return types.InputPeerChat(entity_id)
    return types.InputPeerUser(entity_id, row[0])


async def resolve_chats(account, values, data_dir, *, client_factory=None):
    from telethon import TelegramClient, utils
    if not isinstance(account, str) or not re.fullmatch(r'[\w.-]+', account) or account in ('.', '..'):
        raise ValueError('invalid account')
    if not isinstance(values, list) or not 1 <= len(values) <= 4:
        raise ValueError('invalid batch')
    session_file = Path(data_dir) / (account + '.session')
    if not session_file.is_file():
        raise ValueError('missing session')
    config = read_document('config', Path(data_dir) / 'config.json', parser=parse_config_text)
    user = next(user for user in config.get('telegram', {}).get('users', config.get('users', []))
                if (user.get('session') or user.get('name')) == account)
    api_id, api_hash = resolve_credentials(config, user)
    client = (client_factory or TelegramClient)(authorization_snapshot(session_file), api_id, api_hash,
        device_model='AutoCheckin', receive_updates=False, flood_sleep_threshold=0,
        connection_retries=1, request_retries=0, timeout=8)
    dialogs = None
    results = []
    try:
        await asyncio.wait_for(client.connect(), 10)
        if not await asyncio.wait_for(client.is_user_authorized(), 8):
            raise ValueError('not authorized')
        for value in values:
            try:
                reference = normalize_peer(value)
            except ValueError:
                results.append({'value':value, 'status':'error', 'message':'请填写有效的 ID 或公开用户名'})
                continue
            try:
                peer = cached_numeric_peer(session_file, reference) if isinstance(reference, int) else reference
                try:
                    entity = await asyncio.wait_for(client.get_entity(peer), 8)
                except ValueError:
                    if not isinstance(reference, int):
                        raise
                    if dialogs is None:
                        dialogs = await asyncio.wait_for(client.get_dialogs(limit=1000), 12)
                    entity = next(dialog.entity for dialog in dialogs if utils.get_peer_id(dialog.entity) == reference)
                title = getattr(entity, 'title', None)
                if not title:
                    results.append({'value':value, 'status':'error', 'message':'此会话不是群组或频道'})
                    continue
                results.append({'value':value, 'status':'ok', 'id':str(utils.get_peer_id(entity)),
                                'title':str(title)[:200], 'type':'channel' if getattr(entity, 'broadcast', False) else 'group'})
            except Exception as error:
                message = '查询触发限流，请稍后重试' if getattr(error, 'seconds', None) else '无法获取，请检查 ID、用户名及账号权限'
                results.append({'value':value, 'status':'error', 'message':message})
        return results
    finally:
        await asyncio.wait_for(client.disconnect(), 5)


async def main():
    try:
        results = await asyncio.wait_for(resolve_chats(sys.argv[1], json.loads(sys.argv[2]),
            os.environ.get('AUTOCHECKIN_DATA_DIR') or Path(__file__).resolve().parent), 40)
        print(json.dumps({'results':results}, ensure_ascii=False), flush=True)
        return 0
    except Exception:
        # Errors may contain auth material. Never output Telegram exceptions or session data.
        print(json.dumps({'error':'无法查询名称，请检查登录状态和网络后重试'}, ensure_ascii=False), flush=True)
        return 2


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
