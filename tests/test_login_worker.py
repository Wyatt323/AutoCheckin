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
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
class PasswordNeeded(Exception): pass
class PasswordHashInvalidError(Exception): pass
InvalidPassword = PasswordHashInvalidError
sys.modules['telethon'] = types.SimpleNamespace(TelegramClient=None)
sys.modules['telethon.errors'] = types.SimpleNamespace(SessionPasswordNeededError=PasswordNeeded, PasswordHashInvalidError=InvalidPassword)
import login_worker

from network_guard import install_network_guard
install_network_guard()

class Client:
    def __init__(self, *, authorized=False, password=False, timeout=False, connecting=False, connect_error=None, qr_error=None, disconnect_error=None):
        self.authorized=authorized; self.password=password; self.timeout=timeout; self.connecting=connecting; self.disconnected=False; self.qrs=0; self.attempts=0
        self.connect_error=connect_error; self.qr_error=qr_error; self.disconnect_error=disconnect_error
    async def connect(self):
        if self.connect_error: raise self.connect_error
        if self.connecting: await asyncio.sleep(60)
    async def disconnect(self):
        self.disconnected=True
        if self.disconnect_error: raise self.disconnect_error
    async def is_user_authorized(self): return self.authorized
    async def qr_login(self):
        self.qrs += 1
        if self.qr_error: raise self.qr_error
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
        def factory(*a, **kw):
            args.extend(a)
            self.assertEqual(kw['device_model'], 'AutoCheckin')
            self.assertEqual(kw['flood_sleep_threshold'], 0)
            self.assertEqual(kw['request_retries'], 1)
            return client
        async def password_reader(): return passwords.pop(0)
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            code=await login_worker.login('offline',self.tmp.name,client_factory=factory,password_reader=password_reader)
        self.last_events=[json.loads(line) for line in output.getvalue().splitlines()]
        events=[event for event in self.last_events if event['type'] != 'progress']
        self.assertEqual(args[:3],[str(Path(self.tmp.name,'offline')),123,'sensitive'])
        self.assertNotIn('sensitive',output.getvalue()); self.assertNotIn('tg://',output.getvalue()); self.assertNotIn('never-serialize',output.getvalue())
        self.assertTrue(client.disconnected)
        return code,events
    async def test_qr(self):
        code,events=await self.run_login(Client())
        self.assertEqual(code,0); self.assertEqual([e['type'] for e in events],['QR','success'])
        self.assertTrue(base64.b64decode(events[0]['png']).startswith(b'\x89PNG\r\n\x1a\n'))
    async def test_existing_authorization(self):
        client=Client(authorized=True); code,events=await self.run_login(client)
        self.assertEqual(client.qrs,0); self.assertEqual(events,[{'type':'success'}])
    async def test_profile_only_never_starts_authorization(self):
        client = Client()
        with contextlib.redirect_stdout(io.StringIO()):
            code = await login_worker.login('offline', self.tmp.name, client_factory=lambda *a, **k: client, profile_only=True)
        self.assertEqual(code, 2)
        self.assertEqual(client.qrs, 0)
        self.assertTrue(client.disconnected)
    async def test_profile_only_success_creates_cache(self):
        client = Client(authorized=True)
        client.session = types.SimpleNamespace(dc_id=4)
        async def me(): return types.SimpleNamespace(id=987654321, username=None, first_name='Offline', last_name=None)
        async def photo(*args, **kwargs): return None
        client.get_me = me
        client.download_profile_photo = photo
        with contextlib.redirect_stdout(io.StringIO()):
            code = await login_worker.login('offline', self.tmp.name, client_factory=lambda *a, **k: client, profile_only=True)
        self.assertEqual(code, 0)
        self.assertEqual(client.qrs, 0)
        self.assertTrue(client.disconnected)
        profile = json.loads(next(Path(self.tmp.name, '.account-profiles').glob('*.json')).read_text())
        self.assertEqual(profile['userId'], '987654321')
        self.assertEqual(profile['dcId'], 4)
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
        code,events=await self.run_login(client,['wrong']*3)
        self.assertEqual(code,2); self.assertEqual(events[-1]['code'],'password_invalid')
        self.assertTrue(client.disconnected)
    async def test_failure_before_qr_reports_network_stage_without_secrets(self):
        client=Client(connect_error=ConnectionError('never-serialize tg://login?token=sensitive'))
        code,events=await self.run_login(client)
        self.assertEqual(code,2); self.assertEqual(client.qrs,0)
        self.assertEqual(events,[{'type':'error','code':'network_error','phase':'connect'}])
    async def test_proxy_failure_is_distinct_from_direct_network(self):
        with patch.object(login_worker,'telegram_proxy_kwargs',return_value={'proxy':'offline'}):
            code,events=await self.run_login(Client(connect_error=ConnectionError('never-serialize')))
        self.assertEqual(code,2); self.assertEqual(events[-1]['code'],'proxy_unreachable')
    async def test_api_rejection_is_distinct_from_timeout(self):
        error=type('ApiIdInvalidError',(Exception,),{})('never-serialize sensitive')
        code,events=await self.run_login(Client(qr_error=error))
        self.assertEqual(code,2); self.assertEqual(events[-1],{'type':'error','code':'api_invalid','phase':'qr'})
    async def test_rate_limit_is_not_silently_retried(self):
        error=type('FloodWaitError',(Exception,),{})('never-serialize'); error.seconds=87
        client=Client(qr_error=error)
        code,events=await self.run_login(client)
        self.assertEqual(code,2); self.assertEqual(client.qrs,1)
        self.assertEqual(events[-1]['code'],'rate_limited'); self.assertEqual(events[-1]['retryAfterSeconds'],87)
    async def test_session_busy_preserves_original_error_when_disconnect_fails(self):
        client=Client(connect_error=login_worker.sqlite3.OperationalError('database is locked'),disconnect_error=RuntimeError('never-serialize'))
        code,events=await self.run_login(client)
        self.assertEqual(code,2); self.assertEqual(events[-1]['code'],'session_busy')
    async def test_success_is_not_changed_to_failure_by_disconnect(self):
        code,events=await self.run_login(Client(authorized=True,disconnect_error=ConnectionError('never-serialize')))
        self.assertEqual(code,0); self.assertEqual(events,[{'type':'success'}])
    async def test_missing_dependency_is_reported_without_starting_client(self):
        output=io.StringIO()
        with patch.dict(sys.modules,{'qrcode':None}), contextlib.redirect_stdout(output):
            code=await login_worker.login('offline',self.tmp.name,client_factory=lambda *a,**k:self.fail('must not open session'))
        self.assertEqual(code,2)
        self.assertEqual(json.loads(output.getvalue())['code'],'dependency_missing')
    async def test_configuration_failure_has_no_file_content(self):
        Path(self.tmp.name,'config.json').write_text('never-serialize')
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            code=await login_worker.login('offline',self.tmp.name)
        events=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(code,2); self.assertEqual(events[-1]['code'],'config_unavailable')
        self.assertNotIn('never-serialize',output.getvalue())

if __name__=='__main__': unittest.main()
