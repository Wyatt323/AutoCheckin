"""Offline credential precedence exercised through all three execution paths."""
import asyncio
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from offline_support import TEMP_ROOT
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import allinone
import automation_worker
import login_worker
from telegram_credentials import resolve_credentials

CASES = [({}, (789, 'global')), ({'api_id': '', 'api_hash': None}, (789, 'global')), ({'api_id': 123}, (123, 'global')), ({'api_hash': 'own'}, (789, 'own')), ({'api_id': 123, 'api_hash': 'own'}, (123, 'own'))]

class CredentialTests(unittest.IsolatedAsyncioTestCase):
    async def test_three_paths(self):
        for fields, expected in CASES:
            with self.subTest(fields=fields), tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
                user = {'name': 'offline', 'session': 'offline', 'bots': [], **fields}
                config = {'ai': {'model': '', 'providers': []}, 'telegram': {'api_id': 789, 'api_hash': 'global', 'users': [user]}, 'automations': {'schedules': [{'account': 'offline'}]}}
                before = copy.deepcopy(config)
                file = Path(directory, 'config.json')
                file.write_text(json.dumps(config))
                normalized = allinone.load_config(file)[2][0]
                self.assertEqual((normalized['api_id'], normalized['api_hash']), expected)
                calls = []
                class Client:
                    def __init__(self, session, api_id, api_hash, **kwargs):
                        calls.append((api_id, api_hash))
                    async def connect(self):
                        raise asyncio.CancelledError()
                    async def disconnect(self): pass
                with patch.object(sys.modules['telethon'], 'TelegramClient', Client), patch.object(automation_worker, 'load_config', return_value=config), patch.object(automation_worker, 'load_sent', return_value={}):
                    with self.assertRaises(asyncio.CancelledError): await automation_worker.main()
                self.assertEqual(calls, [expected])
                # Login already-authorized fake avoids QR/image dependencies entirely.
                setattr(sys.modules['telethon.errors'], 'PasswordHashInvalidError', type('InvalidPassword', (Exception,), {}))
                client = type('LoginClient', (), {'connect': AsyncMock(), 'disconnect': AsyncMock(), 'is_user_authorized': AsyncMock(return_value=True)})()
                def factory(session, api_id, api_hash, **kwargs):
                    calls.append((api_id, api_hash)); return client
                with patch.dict(sys.modules, {'qrcode': object()}), patch.object(login_worker, 'emit'):
                    self.assertEqual(await login_worker.login('offline', directory, client_factory=factory), 0)
                self.assertEqual(calls, [expected, expected])
                self.assertEqual(config, before)
                self.assertEqual(json.loads(file.read_text()), before)

    def test_missing_invalid_and_legacy(self):
        self.assertEqual(resolve_credentials({}, {'api_id': 1, 'api_hash': 'old'}), (1, 'old'))
        for config, user in [({}, {}), ({'telegram': {'api_id': 1}}, {}), ({'telegram': {'api_hash': 'x'}}, {})]:
            with self.assertRaises(ValueError): resolve_credentials(config, user)
        for bad in [0, -1, 1.5, '1e3', True, 9007199254740992]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                resolve_credentials({'telegram': {'api_id': 1, 'api_hash': 'x'}}, {'api_id': bad})

if __name__ == '__main__': unittest.main()
