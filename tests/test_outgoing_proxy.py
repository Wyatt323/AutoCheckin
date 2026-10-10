"""Local proxy protocol tests; no real Telegram, AI provider or user credentials."""
import asyncio
import base64
import json
import logging
import os
import ssl
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from collections import defaultdict
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import outgoing_proxy as proxy

CERT = Path(__file__).parent / 'fixtures/proxy-test-cert.pem'
KEY = CERT.with_name('proxy-test-key.pem')  # Public fixture material, never for deployment.


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_wide_guard_and_normal_proxy_clients(self):
        # Audit hooks cannot be removed: use a fresh worker process, as production does.
        script = '''
import asyncio, json, socket, sys, ssl
import outgoing_proxy as proxy
original_context = ssl.create_default_context
def trusted_context(*args, **kwargs):
    context = original_context(*args, **kwargs)
    context.load_verify_locations(sys.argv[2])
    return context
ssl.create_default_context = trusted_context
proxy.read_proxy = lambda: json.loads(sys.argv[1])
proxy.install_network_guard()
for action in (lambda: socket.create_connection(('127.0.0.1', 1)),
               lambda: socket.getaddrinfo('bypass.invalid', 80),
               lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('127.0.0.1', 9))):
    try:
        action()
    except ConnectionError as error:
        assert '禁止绕过代理' in str(error)
    else:
        raise AssertionError('direct networking bypassed policy')
async def run():
    reader, writer = await proxy.open_tunnel(proxy.read_proxy(), 'telegram.invalid', 443)
    writer.write(b'GET / HTTP/1.1\\r\\nHost: telegram.invalid\\r\\n\\r\\n')
    await writer.drain()
    assert b'200 OK' in await reader.read(4096)
    writer.close()
    await writer.wait_closed()
asyncio.run(run())
with proxy.ai_http_client() as client:
    assert client.get('http://ai.invalid').json() == {'ok': True}
print('worker guard PASS')
'''
        for kind in ['http', 'https', 'socks5']:
            configured = await self.make_proxy(kind)
            worker = await asyncio.create_subprocess_exec(sys.executable, '-c', script, json.dumps(configured), str(CERT),
                cwd=Path(__file__).resolve().parents[1], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(worker.communicate(), 20)
            self.assertEqual(worker.returncode, 0, stderr.decode(errors='replace'))
            self.assertIn(b'worker guard PASS', stdout)

    async def asyncSetUp(self):
        self.servers = []
        self.writers = []
        self.destinations = []
        self.real_context = ssl.create_default_context

    async def asyncTearDown(self):
        for writer in self.writers:
            writer.close()
        for server in self.servers:
            server.close()
            await server.wait_closed()

    def trusted_context(self, *args, **kwargs):
        context = self.real_context(*args, **kwargs)
        context.load_verify_locations(CERT)
        return context

    async def make_proxy(self, kind, reject=False, authenticated=True, secure_target=False):
        async def handler(reader, writer):
            self.writers.append(writer)
            try:
                if kind == 'socks5':
                    method = 2 if authenticated else 0
                    self.assertEqual(await reader.readexactly(3), bytes([5,1,method]))
                    writer.write(bytes([5,method]));await writer.drain()
                    if authenticated:
                        version, length = await reader.readexactly(2)
                        self.assertEqual(version, 1)
                        self.assertEqual(await reader.readexactly(length), b'user')
                        length = (await reader.readexactly(1))[0]
                        self.assertEqual(await reader.readexactly(length), b'p@ss word')
                        writer.write(b'\x01\x01' if reject else b'\x01\x00');await writer.drain()
                    if reject:
                        return
                    head = await reader.readexactly(5)
                    self.assertEqual(head[:4], b'\x05\x01\x00\x03')
                    host = (await reader.readexactly(head[4])).decode()
                    port = int.from_bytes(await reader.readexactly(2), 'big')
                    self.destinations.append((host, port))
                    writer.write(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
                else:
                    header = await reader.readuntil(b'\r\n\r\n')
                    if authenticated:
                        self.assertIn((b'Proxy-Authorization: Basic ' + base64.b64encode(b'user:p@ss word')).lower(), header.lower())
                    else:
                        self.assertNotIn(b'proxy-authorization', header.lower())
                    self.destinations.append(header.split(b'\r\n')[0].decode())
                    if header.startswith(b'GET '):
                        writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}')
                        await writer.drain()
                        return
                    writer.write(b'HTTP/1.1 407 Rejected\r\n\r\n' if reject else b'HTTP/1.1 200 Connected\r\n\r\n')
                    if reject:
                        await writer.drain()
                        return
                await writer.drain()
                if secure_target:
                    target_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    target_context.load_cert_chain(CERT, KEY)
                    await writer.start_tls(target_context)
                message = await reader.read(4096)
                if message.startswith(b'GET '):
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}')
                else:
                    writer.write(message)
                await writer.drain()
            finally:
                writer.close()
        context = None
        if kind == 'https':
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(CERT, KEY)
        server = await asyncio.start_server(handler, '127.0.0.1', 0, ssl=context)
        self.servers.append(server)
        return dict(type=kind, host='127.0.0.1', port=server.sockets[0].getsockname()[1], username='user' if authenticated else '', password='p@ss word' if authenticated else '')

    async def test_telegram_tunnels_all_types(self):
        for kind in ['http', 'https', 'socks5']:
            settings = await self.make_proxy(kind)
            with patch.object(proxy.ssl, 'create_default_context', self.trusted_context):
                reader, writer = await proxy.open_tunnel(settings, 'no-local-dns.invalid', 443)
            writer.write(b'HELLO');await writer.drain()
            self.assertEqual(await reader.readexactly(5), b'HELLO')
            writer.close();await writer.wait_closed()
        self.assertEqual(self.destinations[-1], ('no-local-dns.invalid', 443))

    async def test_ai_requests_use_proxy_and_ignore_no_proxy(self):
        for kind in ['http', 'https', 'socks5']:
            settings = await self.make_proxy(kind)
            with patch.object(proxy, 'read_proxy', return_value=settings), patch.object(proxy.ssl, 'create_default_context', self.trusted_context), patch.dict(os.environ, {'NO_PROXY':'*'}):
                client = proxy.ai_http_client()
                try:
                    response = await asyncio.to_thread(client.get, 'http://no-local-dns.invalid/test')
                    self.assertEqual(response.json(), {'ok':True})
                finally:
                    client.close()

    async def test_ai_https_through_https_proxy(self):
        settings = await self.make_proxy('https', secure_target=True)
        with patch.object(proxy, 'read_proxy', return_value=settings), patch.object(proxy.ssl, 'create_default_context', self.trusted_context):
            client = proxy.ai_http_client()
            try:
                response = await asyncio.to_thread(client.get, 'https://localhost/test')
                self.assertEqual(response.json(), {'ok':True})
            finally:
                client.close()

    async def test_telethon_connection_uses_tunnel(self):
        settings = await self.make_proxy('socks5')
        connection = proxy.proxy_connection()('no-local-dns.invalid', 443, 1,
            loggers=defaultdict(lambda: logging.getLogger('offline-proxy')), proxy=settings)
        await connection._connect(timeout=5)
        self.assertIsNotNone(connection._codec)
        connection._writer.write(b'HELLO');await connection._writer.drain()
        self.assertEqual(await connection._reader.readexactly(5), b'HELLO')
        connection._writer.close();await connection._writer.wait_closed()

    async def test_failure_never_connects_to_destination(self):
        for kind in ['http', 'socks5']:
            settings = await self.make_proxy(kind, reject=True)
            with self.assertRaisesRegex(ConnectionError, '出口代理连接失败'):
                await proxy.open_tunnel(settings, 'no-local-dns.invalid', 443)

    async def test_unauthenticated_proxies(self):
        for kind in ['http', 'socks5']:
            settings = await self.make_proxy(kind, authenticated=False)
            reader, writer = await proxy.open_tunnel(settings, 'no-local-dns.invalid', 443)
            writer.write(b'HELLO');await writer.drain()
            self.assertEqual(await reader.readexactly(5), b'HELLO')
            writer.close();await writer.wait_closed()

    async def test_telegram_kwargs_and_persistent_global_lookup(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'DATABASE_URL':'', 'PGHOST':'', 'AUTOCHECKIN_SYSTEM_DATA_DIR':directory, 'AUTOCHECKIN_DOCUMENT_PREFIX':'tenant:other:'}):
            root=Path(directory)
            self.assertEqual(proxy.telegram_proxy_kwargs(), {})
            settings=dict(enabled=True,type='https',host='proxy.invalid',port=443,username='',password='')
            (root/'.system-settings.json').write_text(json.dumps({'proxy':settings}))
            kwargs=proxy.telegram_proxy_kwargs()
            self.assertEqual(kwargs['proxy']['type'], 'https')
            self.assertIs(kwargs['connection'], proxy.proxy_connection())
            settings['type']='invalid'
            (root/'.system-settings.json').write_text(json.dumps({'proxy':settings}))
            with self.assertRaisesRegex(ValueError, '代理配置无效'):
                proxy.telegram_proxy_kwargs()


if __name__ == '__main__':
    unittest.main()
