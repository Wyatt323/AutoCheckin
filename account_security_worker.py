"""One bounded inspection on an idle Session; shared listeners use the same operations."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from account_security import operate, error_result
from storage import read_document, parse_config_text
from telegram_credentials import resolve_credentials
from outgoing_proxy import telegram_proxy_kwargs, install_network_guard


async def run(account, command):
    from telethon import TelegramClient
    directory = Path(os.environ.get('AUTOCHECKIN_DATA_DIR') or Path(__file__).parent)
    config = read_document('config', directory / 'config.json', parser=parse_config_text)
    user = next((item for item in config.get('telegram', {}).get('users', config.get('users', []))
                 if (item.get('session') or item.get('name')) == account), None)
    if not user or not (directory / f'{account}.session').is_file():
        return {'status': 'login_required', 'detail': '账号尚未登录，请先登录 Telegram'}
    client = None
    try:
        api_id, api_hash = resolve_credentials(config, user)
        client = TelegramClient(str(directory / account), api_id, api_hash, device_model='AutoCheckin',
            receive_updates=False, connection_retries=1, request_retries=0,
            flood_sleep_threshold=0, timeout=10, **telegram_proxy_kwargs(user))
        await asyncio.wait_for(client.connect(), 15)
        return await asyncio.wait_for(operate(client, command.get('action'), command.get('hash'), command.get('appealText', ''), command.get('pledge', False)), 110 if str(command.get('action', '')).startswith('spam_') else 55)
    except Exception as error:
        return error_result(error)
    finally:
        if client:
            try:
                await asyncio.wait_for(client.disconnect(), 5)
            except Exception:
                pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--account', required=True)
    args = parser.parse_args()
    install_network_guard()
    command = json.loads(sys.stdin.readline(16384))
    result = asyncio.run(run(args.account, command))
    print(json.dumps({'type': 'account_security', 'result': result}, ensure_ascii=False), flush=True)
