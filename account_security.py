"""Account safety inspection and explicitly requested device revocation; no messages."""
import asyncio
from datetime import timezone


def error_result(error):
    name = type(error).__name__
    if name in {'UserDeactivatedBanError', 'PhoneNumberBannedError'}:
        return {'status': 'banned', 'detail': 'Telegram 返回账号已被封禁'}
    if name == 'UserDeactivatedError':
        return {'status': 'deactivated', 'detail': 'Telegram 返回账号已停用'}
    if name in {'AuthKeyUnregisteredError', 'AuthKeyDuplicatedError', 'SessionRevokedError', 'SessionExpiredError'}:
        return {'status': 'login_required', 'detail': 'Telegram 登录已失效，请重新登录'}
    if name.startswith('Frozen'):
        return {'status': 'restricted', 'detail': 'Telegram 返回账号冻结或操作受限，请在官方客户端查看'}
    if name == 'FreshResetAuthorisationForbiddenError':
        return {'status': 'action_blocked', 'detail': 'Telegram 暂不允许新登录的设备下线其他设备，请使用较早登录的客户端操作'}
    seconds = getattr(error, 'seconds', 0)
    if isinstance(seconds, (int, float)) and seconds > 0:
        return {'status': 'rate_limited', 'detail': 'Telegram 要求等待，巡检将在冷却结束后恢复', 'waitSeconds': int(seconds)}
    return {'status': 'unavailable', 'detail': '检查失败或超时，请检查网络、代理及登录状态后重试'}


def stamp(value):
    return value.astimezone(timezone.utc).isoformat() if value else None


async def request(client, rpc):
    return await asyncio.wait_for(client(rpc, flood_sleep_threshold=0), 12)


async def inspect_client(client):
    from telethon import functions, types
    users = await request(client, functions.users.GetUsersRequest([types.InputUserSelf()]))
    if not users:
        return {'status': 'login_required', 'detail': 'Telegram 登录已失效，请重新登录'}
    me = users[0]
    password = await request(client, functions.account.GetPasswordRequest())
    sessions = await request(client, functions.account.GetAuthorizationsRequest())
    devices = []
    for auth in sessions.authorizations:
        devices.append({
            'hash': str(auth.hash), 'current': bool(auth.current),
            'device': auth.device_model, 'platform': auth.platform,
            'system': auth.system_version, 'app': auth.app_name, 'version': auth.app_version,
            'ip': auth.ip, 'country': auth.country, 'region': auth.region,
            'createdAt': stamp(auth.date_created), 'activeAt': stamp(auth.date_active),
            'unconfirmed': bool(getattr(auth, 'unconfirmed', False)),
            'passwordPending': bool(getattr(auth, 'password_pending', False)),
        })
    restricted = bool(getattr(me, 'restricted', False))
    return {
        'status': 'restricted' if restricted else 'reachable',
        'detail': 'Telegram 返回账号限制标记，请在官方客户端核实' if restricted else '身份与安全信息读取正常；不代表所有发言权限均正常',
        'userId': str(me.id), 'twoFactor': bool(password.has_password),
        'recoveryEmail': bool(password.has_recovery),
        'flags': {'restricted': restricted, 'scam': bool(getattr(me, 'scam', False)), 'fake': bool(getattr(me, 'fake', False))},
        'restrictionReasons': [str(getattr(reason, 'text', ''))[:300] for reason in getattr(me, 'restriction_reason', None) or []],
        'devices': devices,
    }


async def operate(client, action='inspect', device_hash=None, appeal_text='', pledge=False):
    from telethon import functions
    if action in {'spam_check', 'spam_appeal'}:
        from spam_bot import run
        return await run(client, action, appeal_text, pledge)
    terminated = False
    try:
        if action == 'terminate':
            # Re-read Telegram state: a stale web snapshot cannot revoke the current session.
            sessions = await request(client, functions.account.GetAuthorizationsRequest())
            device = next((auth for auth in sessions.authorizations if str(auth.hash) == str(device_hash)), None)
            if device is None:
                return {'status': 'action_blocked', 'detail': '该设备已不存在，请刷新设备列表'}
            if device.current:
                return {'status': 'action_blocked', 'detail': '不能下线 AutoCheckin 当前使用的会话'}
            result = await request(client, functions.account.ResetAuthorizationRequest(hash=device.hash))
            if not result:
                return {'status': 'action_blocked', 'detail': 'Telegram 未确认设备已下线，请刷新后核实'}
            terminated = True
        elif action != 'inspect':
            return {'status': 'action_blocked', 'detail': '不支持的账号防护操作'}
        result = await inspect_client(client)
    except Exception as error:
        result = error_result(error)
    if terminated:
        result['terminated'] = True
    return result
