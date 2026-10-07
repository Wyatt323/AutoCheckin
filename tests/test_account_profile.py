import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_profile import save_profile
from network_guard import install_network_guard
install_network_guard()


class Client:
    session = types.SimpleNamespace(dc_id=2)
    avatar = b'\xff\xd8\xffoffline-thumbnail'
    async def get_me(self):
        return types.SimpleNamespace(id=123456789012, username='offline_user', first_name='Offline', last_name='User')
    async def download_profile_photo(self, user, *, file, download_big):
        assert file is bytes and download_big is False
        if isinstance(self.avatar, Exception):
            raise self.avatar
        return self.avatar


class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_cache_replacement_and_photo_failure(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as root:
            client = Client()
            profile = await save_profile(client, 'offline', root)
            self.assertEqual(profile['userId'], '123456789012')
            self.assertEqual(profile['dcId'], 2)
            self.assertEqual(base64.b64decode(profile['avatar']), client.avatar)
            client.avatar = TimeoutError()
            retained = await save_profile(client, 'offline', root)
            self.assertEqual(retained['avatar'], profile['avatar'])
            client.avatar = None
            cleared = await save_profile(client, 'offline', root)
            self.assertIsNone(cleared['avatar'], 'removed TG photo must clear cached photo')
            target = Path(root, '.account-profiles', hashlib.sha256(b'offline').hexdigest() + '.json')
            self.assertEqual(json.loads(target.read_text())['userId'], profile['userId'])
            self.assertFalse(list(target.parent.glob('*.tmp')))
            self.assertEqual(set(cleared), {'userId', 'dcId', 'username', 'displayName', 'updatedAt', 'avatar'})

    async def test_new_user_does_not_inherit_previous_avatar(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as root:
            client = Client()
            await save_profile(client, 'offline', root)
            async def other():
                return types.SimpleNamespace(id=555, username=None, first_name='New', last_name=None)
            client.get_me = other
            client.avatar = OSError()
            profile = await save_profile(client, 'offline', root)
            self.assertIsNone(profile['avatar'])
            self.assertEqual(profile['displayName'], 'New')


if __name__ == '__main__': unittest.main()
