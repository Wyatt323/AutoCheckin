import asyncio
import base64
import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
class PasswordNeeded(Exception): pass
class InvalidPassword(Exception): pass
sys.modules['telethon'] = types.SimpleNamespace(TelegramClient=None)
sys.modules['telethon.errors'] = types.SimpleNamespace(SessionPasswordNeededError=PasswordNeeded, PasswordHashInvalidError=InvalidPassword)
import login_worker

def blocked(*args, **kwargs): raise AssertionError('Network forbidden')
socket.socket.connect = blocked
socket.socket.connect_ex = blocked
socket.create_connection = blocked

class Client:
    def __init__(self, *, authorized=False, password=False, timeout=False, connecting=False):
        self.authorized=authorized; self.password=password; self.timeout=timeout; self.connecting=connecting; self.disconnected=False; self.qrs=0; self.attempts=0
    async def connect(self):
        if self.connecting: await asyncio.sleep(60)
    async def disconnect(self): self.disconnected=True
    async def is_user_authorized(self): return self.authorized
    async def qr_login(self):
        self.qrs += 1
        return types.SimpleNamespace(url='tg://login?token=offline-only', expires=datetime.datetime.now(datetime.timezone.utc), wait=self.wait)
    async def wait(self, timeout):
        if self.timeout: raise asyncio.TimeoutError()
        if self.password: raise PasswordNeeded()
        self.authorized=True
    async def sign_in(self, password):
        self.attempts += 1
        if password != 'correct': raise InvalidPassword()
        self.authorized=True

class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        Path(self.tmp.name,'config.json').write_text(json.dumps({'telegram':{'users':[{'session':'offline','api_id':123,'api_hash':'sensitive'}]}}))
    def tearDown(self): self.tmp.cleanup()
    async def run_login(self, client, passwords=None):
        args=[]
        def factory(*a, **kw): args.extend(a); return client
        async def password_reader(): return passwords.pop(0)
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            code=await login_worker.login('offline',self.tmp.name,client_factory=factory,password_reader=password_reader)
        events=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(args[:3],[str(Path(self.tmp.name,'offline')),123,'sensitive'])
        self.assertNotIn('sensitive',output.getvalue()); self.assertNotIn('tg://',output.getvalue())
        self.assertTrue(client.disconnected)
        return code,events
    async def test_qr(self):
        code,events=await self.run_login(Client())
        self.assertEqual(code,0); self.assertEqual([e['type'] for e in events],['QR','success'])
        self.assertTrue(base64.b64decode(events[0]['png']).startswith(b'\x89PNG\r\n\x1a\n'))
    async def test_existing_authorization(self):
        client=Client(authorized=True); code,events=await self.run_login(client)
        self.assertEqual(client.qrs,0); self.assertEqual(events,[{'type':'success'}])
    async def test_password_retry(self):
        client=Client(password=True); code,events=await self.run_login(client,['wrong','correct'])
        self.assertEqual(code,0); self.assertEqual(client.attempts,2)
        self.assertEqual([e['type'] for e in events],['QR','password_required','password_required','success'])
        self.assertTrue(events[2]['invalid'])
    async def test_timeout(self):
        client=Client(timeout=True); code,events=await self.run_login(client)
        self.assertEqual(code,2); self.assertEqual(client.qrs,6); self.assertEqual(events[-1]['type'],'error')
    async def test_cancel_connect(self):
        client=Client(connecting=True)
        task=asyncio.create_task(login_worker.login('offline',self.tmp.name,client_factory=lambda *a,**k:client))
        await asyncio.sleep(.01); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(client.disconnected)
    async def test_password_failure_cleanup(self):
        client=Client(password=True)
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(InvalidPassword): await self.run_login(client,['wrong']*3)
        self.assertTrue(client.disconnected)

if __name__=='__main__': unittest.main()
