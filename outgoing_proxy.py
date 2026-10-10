"""Shared outbound proxy for every Telegram worker and AI HTTP client."""
import asyncio
import base64
import ipaddress
import os
import re
import ssl
import socket
import sys
from functools import lru_cache
from contextvars import ContextVar
from pathlib import Path
from urllib.parse import quote
from storage import read_document


def install_network_guard():
    """Worker-wide fail-closed policy, including networking inside dependencies.

    Workers restart after proxy changes. Only the proxy endpoint can open an
    Internet socket; Telethon and HTTPX perform their protocol over that socket.
    Local socketpairs used by asyncio and libpq persistence are not Internet IO.
    """
    proxy = read_proxy()
    if not proxy:
        return
    addresses = {entry[4][0] for entry in socket.getaddrinfo(proxy['host'], proxy['port'], type=socket.SOCK_STREAM)}
    # Windows implements socketpair with loopback TCP; allow that internal IPC
    # only while socketpair itself is creating it, never ordinary localhost IO.
    making_pair = ContextVar('autocheckin_socketpair', default=False)
    original_pair = socket.socketpair
    def socketpair(*args, **kwargs):
        token = making_pair.set(True)
        try:
            return original_pair(*args, **kwargs)
        finally:
            making_pair.reset(token)
    socket.socketpair = socketpair
    def audit(event, args):
        if event == 'socket.getaddrinfo':
            host = args[0].decode() if isinstance(args[0], bytes) else args[0]
            try:
                ipaddress.ip_address(host)
            except ValueError:
                if str(host).lower() != proxy['host'].lower():
                    raise ConnectionError('已启用系统出口代理，禁止绕过代理解析外部域名')
        elif event in ('socket.connect', 'socket.sendto'):
            transport, address = args[0], args[-1]
            if transport.family not in (socket.AF_INET, socket.AF_INET6):
                return
            if making_pair.get() and isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback:
                return
            if (transport.type != socket.SOCK_STREAM or not isinstance(address, tuple)
                    or address[0] not in addresses or address[1] != proxy['port']):
                raise ConnectionError('已启用系统出口代理，禁止绕过代理直接联网')
    sys.addaudithook(audit)


def read_proxy():
    root = Path(os.environ.get('AUTOCHECKIN_SYSTEM_DATA_DIR') or os.environ.get('AUTOCHECKIN_DATA_DIR') or Path(__file__).resolve().parent)
    settings = read_document('system-settings', root / '.system-settings.json', default={}, system=True)
    proxy = settings.get('proxy') or {}
    if proxy.get('enabled') is not True:
        return None
    try:
        host = str(proxy['host']).strip().strip('[]')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if not re.fullmatch(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?', host) or len(host) > 253:
                raise ValueError()
        port = int(proxy['port'])
        kind = proxy['type']
        username, password = str(proxy.get('username') or ''), str(proxy.get('password') or '')
        if kind not in ('http', 'https', 'socks5') or not 1 <= port <= 65535:
            raise ValueError()
        if any(c in username for c in '\r\n\0:') or any(c in password for c in '\r\n\0') or max(len(username.encode()), len(password.encode())) > 255:
            raise ValueError()
        if password and not username:
            raise ValueError()
        return dict(type=kind, host=host, port=port, username=username, password=password)
    except (KeyError, TypeError, ValueError):
        raise ValueError('出口代理配置无效，请联系管理员检查') from None


async def open_tunnel(proxy, host, port, timeout=15):
    writer = None
    async def connect():
        nonlocal writer
        context = ssl.create_default_context() if proxy['type'] == 'https' else None
        reader, writer = await asyncio.open_connection(proxy['host'], proxy['port'], ssl=context,
                                                       server_hostname=proxy['host'] if context else None, limit=32768)
        username, password = proxy.get('username') or '', proxy.get('password') or ''
        if proxy['type'] == 'socks5':
            method = 2 if username else 0
            writer.write(bytes([5, 1, method]))
            await writer.drain()
            if await reader.readexactly(2) != bytes([5, method]):
                raise ValueError()
            if username:
                user, secret = username.encode(), password.encode()
                writer.write(bytes([1, len(user)]) + user + bytes([len(secret)]) + secret)
                await writer.drain()
                if await reader.readexactly(2) != b'\x01\x00':
                    raise ValueError()
            destination = host.encode('idna')
            if not 1 <= len(destination) <= 255:
                raise ValueError()
            # Let the proxy resolve names; NO_PROXY and local DNS never bypass it.
            writer.write(bytes([5, 1, 0, 3, len(destination)]) + destination + int(port).to_bytes(2, 'big'))
            await writer.drain()
            reply = await reader.readexactly(4)
            if reply[:3] != b'\x05\x00\x00':
                raise ValueError()
            length = 4 if reply[3] == 1 else 16 if reply[3] == 4 else (await reader.readexactly(1))[0] if reply[3] == 3 else 0
            if not length:
                raise ValueError()
            await reader.readexactly(length + 2)
        else:
            destination = f'[{host}]:{port}' if ':' in host else f'{host}:{port}'
            authentication = 'Proxy-Authorization: Basic ' + base64.b64encode(f'{username}:{password}'.encode()).decode() + '\r\n' if username else ''
            writer.write(f'CONNECT {destination} HTTP/1.1\r\nHost: {destination}\r\n{authentication}\r\n'.encode())
            await writer.drain()
            header = await reader.readuntil(b'\r\n\r\n')
            if not re.match(rb'HTTP/1\.[01] 200(?:\s|\r)', header):
                raise ValueError()
        return reader, writer
    try:
        return await asyncio.wait_for(connect(), timeout or 15)
    except BaseException as error:
        if writer:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 2)
            except Exception:
                pass
        if isinstance(error, asyncio.CancelledError):
            raise
        raise ConnectionError('出口代理连接失败，请检查代理配置、认证及网络') from None


@lru_cache(maxsize=1)
def proxy_connection():
    # Lazy import keeps disabled-proxy workers and offline fixtures lightweight.
    from telethon.network.connection import ConnectionTcpFull
    class ProxyConnection(ConnectionTcpFull):
        async def _connect(self, timeout=None, ssl=None):
            if ssl or self._local_addr:
                raise ValueError('出口代理不支持额外的 Telegram SSL/local_addr 参数')
            self._reader, self._writer = await open_tunnel(self._proxy, self._ip, self._port, timeout)
            self._codec = self.packet_codec(self)
            self._init_conn()
            await self._writer.drain()
    return ProxyConnection


def telegram_proxy_kwargs():
    proxy = read_proxy()
    return {'connection': proxy_connection(), 'proxy': proxy} if proxy else {}


def ai_http_client():
    proxy = read_proxy()
    if not proxy:
        return None
    import httpx
    host = f"[{proxy['host']}]" if ':' in proxy['host'] else proxy['host']
    authentication = quote(proxy['username'], safe='') + ':' + quote(proxy['password'], safe='') + '@' if proxy['username'] else ''
    scheme = 'socks5h' if proxy['type'] == 'socks5' else proxy['type']
    url = f"{scheme}://{authentication}{host}:{proxy['port']}"
    return httpx.Client(proxy=url, timeout=30, trust_env=False)
