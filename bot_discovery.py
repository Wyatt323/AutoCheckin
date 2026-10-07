"""Conservative per-account folder Bot discovery with durable reuse."""
import datetime
import hashlib
from pathlib import Path
from storage import read_document, write_document


def location(account, root):
    digest = hashlib.sha256(account.encode('utf-8')).hexdigest()
    return 'discovery:' + digest, Path(root) / '.bot-discovery' / (digest + '.json')


async def run_discovered_bot(signer, bot, account, root, execute):
    key, path = location(account, root)
    records = read_document(key, path, default={}) or {}
    record = records.get(bot.lower())
    if record and record.get('mode') == 'unsupported':
        print(f'⏭️ {bot} 未发现签到按钮或命令，使用识别记录跳过')
        signer.result = '⏭️ 无签到方式'
        signer.done = True
        return True
    if record and record.get('mode') in ('button', 'command'):
        signer.command = record.get('command') if record['mode'] == 'command' else None
        success = await execute(signer, bot)
        record['lastResult'] = 'success' if success else 'failed'
        record['lastRunAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_document(key, records, path)
        return success

    # First try /start + a recognizable sign-in button, then the two requested commands.
    found = None
    responses = []
    for command in (None, '/sign', '/checkin'):
        signer.reset_for_rerun()
        signer.command = command
        signer.clicked_sign_button = False
        signer.saw_response = False
        success = await execute(signer, bot, timeout=20)
        responses.append(signer.saw_response)
        if success or signer.clicked_sign_button:
            found = {'mode': 'command' if command else 'button', 'command': command,
                     'lastResult': 'success' if success else 'failed'}
            break
        # Never mark a network failure/timeout as permanently unsupported.
        if signer.result == '❌ 失败':
            print(f'⚠️ {bot} 无有效响应，暂不记录签到方式，下次重试')
            return False
    if found is None:
        if not all(responses):
            records[bot.lower()] = {'bot':bot, 'mode':'unknown', 'command':None, 'noSignButton':True,
                                   'lastResult':'unconfirmed', 'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            write_document(key, records, path)
            print(f'⚠️ {bot} 方式尚未确认，下次继续识别')
            return False
        found = {'mode':'unsupported', 'command':None, 'lastResult':'no_method'}
        signer.result = '⏭️ 无签到方式'
        success = True
    found['bot'] = bot
    found['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    records[bot.lower()] = found
    write_document(key, records, path)
    print(f"📝 {bot} 已记录：{found['command'] or found['mode']}")
    return success
