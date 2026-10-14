"""Bounded read-only account check, only when no other worker owns its Session."""
import argparse
import asyncio
import json
import os
from pathlib import Path

from storage import read_document, parse_config_text
from telegram_credentials import resolve_credentials
from outgoing_proxy import telegram_proxy_kwargs, install_network_guard
from worker_health import AUTH_ERRORS


async def check(account):
    from telethon import TelegramClient, functions
    directory = Path(os.environ.get('AUTOCHECKIN_DATA_DIR') or Path(__file__).parent)
    config = read_document('config', directory / 'config.json', parser=parse_config_text)
    user = next((item for item in config.get('telegram', {}).get('users', [])
                 if (item.get('session') or item.get('name')) == account), None)
    if user is None or not (directory / f'{account}.session').is_file():
        return 'login_required', '账号尚未登录或 Session 不存在'
    client = None
    try:
        api_id, api_hash = resolve_credentials(config, user)
        client = TelegramClient(str(directory / account), api_id, api_hash,
            device_model='AutoCheckin', receive_updates=False, connection_retries=1,
            request_retries=1, flood_sleep_threshold=0, timeout=10, **telegram_proxy_kwargs(user))
        await asyncio.wait_for(client.connect(), 15)
        if not await asyncio.wait_for(client.is_user_authorized(), 10):
            return 'login_required', 'Telegram 登录已失效，请重新登录'
        await asyncio.wait_for(client(functions.updates.GetStateRequest()), 10)
        return 'online', 'Telegram 连接与请求正常'
    except Exception as error:
        if type(error).__name__ in AUTH_ERRORS:
            return 'login_required', 'Telegram 登录已失效，请重新登录'
        if getattr(error, 'seconds', 0):
            return 'rate_limited', 'Telegram 暂时限流，请稍后检查'
        return 'offline', 'Telegram 连接失败或超时，请检查 API、代理与网络'
    finally:
        if client:
            await client.disconnect()


async def main(account):
    status, detail = await check(account)
    print(json.dumps({'type':'health', 'source':'probe', 'account':account,
                      'status':status, 'detail':detail}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--account', required=True)
    args = parser.parse_args()
    install_network_guard()
    asyncio.run(main(args.account))
