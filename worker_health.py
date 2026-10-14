"""Connection telemetry from the client that already owns the Telegram Session."""
import asyncio
import time

AUTH_ERRORS = {'AuthKeyUnregisteredError', 'AuthKeyDuplicatedError', 'SessionRevokedError',
               'UserDeactivatedError', 'UserDeactivatedBanError'}


async def heartbeat(client, account, source, emit, interval=10, probe_interval=60):
    from telethon import functions
    last_probe = time.monotonic()
    retry_after = 0
    status, detail = 'online', 'Telegram 连接正常'
    while True:
        connected = getattr(client, 'is_connected', lambda: True)()
        if not connected:
            status, detail = 'offline', 'Telegram 连接断开，正在自动重连'
        elif time.monotonic() >= retry_after and time.monotonic() - last_probe >= probe_interval and callable(client):
            last_probe = time.monotonic()
            try:
                await asyncio.wait_for(client(functions.updates.GetStateRequest(), flood_sleep_threshold=0), 10)
                status, detail = 'online', 'Telegram 连接与请求正常'
            except Exception as error:
                if type(error).__name__ in AUTH_ERRORS:
                    status, detail = 'login_required', 'Telegram 登录已失效，请重新登录'
                elif getattr(error, 'seconds', 0):
                    status, detail = 'rate_limited', 'Telegram 暂时限流，等待恢复'
                    retry_after = time.monotonic()+max(1, error.seconds)
                else:
                    status, detail = 'offline', 'Telegram 请求失败或超时，等待重连'
        elif status == 'offline' and connected:
            # Verify a recovered transport before reporting it as healthy.
            last_probe = 0
        emit('', kind='health', source=source, account=account, status=status, detail=detail)
        await asyncio.sleep(interval)
