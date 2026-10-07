import asyncio
import contextlib
import io
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock
from offline_support import TEMP_ROOT
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import allinone
from bot_discovery import run_discovered_bot, location
from storage import read_document


class FakeSigner:
    def reset_for_rerun(self):
        self.command = None
        self.clicked_sign_button = False
        self.saw_response = False
        self.done = False
        self.result = None


class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_learn_methods_reuse_and_unsupported(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as root:
            calls = []
            async def execute(signer, bot, timeout=120):
                calls.append((bot,signer.command))
                signer.saw_response = True
                signer.clicked_sign_button = bot == '@button_bot' and signer.command is None
                success = signer.clicked_sign_button or bot == '@sign_bot' and signer.command == '/sign' or bot == '@check_bot' and signer.command == '/checkin'
                signer.result = '🎉 签到成功' if success else '⏰ 超时'
                return success
            for bot, mode, command in [('@button_bot','button',None),('@sign_bot','command','/sign'),('@check_bot','command','/checkin'),('@nothing_bot','unsupported',None)]:
                signer = FakeSigner(); signer.reset_for_rerun()
                await run_discovered_bot(signer,bot,'account',root,execute)
                key,path = location('account',root)
                record = read_document(key,path)[bot]
                self.assertEqual((record['mode'],record['command']),(mode,command))
                calls.clear()
                await run_discovered_bot(signer,bot,'account',root,execute)
                self.assertEqual(calls, [] if mode=='unsupported' else [(bot,command)])

    async def test_silent_bot_and_network_failure_not_permanent_skip(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as root:
            calls = []
            async def execute(signer, bot, timeout=120):
                calls.append(signer.command)
                signer.result = '⏰ 超时'
                return False
            signer = FakeSigner(); signer.reset_for_rerun()
            await run_discovered_bot(signer,'@silent_bot','account',root,execute)
            self.assertEqual(calls,[None,'/sign','/checkin'])
            key,path=location('account',root)
            self.assertEqual(read_document(key,path)['@silent_bot']['mode'],'unknown')
            async def failed(signer, bot, timeout=120):
                signer.result='❌ 失败'; return False
            await run_discovered_bot(signer,'@broken_bot','account',root,failed)
            self.assertNotIn('@broken_bot',read_document(key,path))

    async def test_folder_is_authoritative_and_includes_only_bots(self):
        class Client:
            async def __call__(self, request):
                return types.SimpleNamespace(filters=[types.SimpleNamespace(id=4,title=types.SimpleNamespace(text='Check-ins'),bots=True)])
            async def iter_dialogs(self, folder=None):
                self.folder=folder
                for entity in [types.SimpleNamespace(bot=True,username='new_bot'),types.SimpleNamespace(bot=False,username='human'),types.SimpleNamespace(bot=True,username=None,id=777)]:
                    yield types.SimpleNamespace(entity=entity)
        client=Client()
        self.assertEqual(await allinone.get_account_bots(client,['@configured_bot'],'4'),['777','@new_bot'])
        self.assertIsNone(client.folder,'custom folder must not be sent as archive folder ID')
        self.assertEqual(await allinone.get_account_bots(client,[],'Check-ins'),['777','@new_bot'])
        class Broken:
            async def __call__(self, request):
                return types.SimpleNamespace(filters=[types.SimpleNamespace(id=4,bots=True)])
            async def iter_dialogs(self, folder=None):
                raise OSError('offline'); yield
        with self.assertRaises(RuntimeError): await allinone.get_account_bots(Broken(),['@configured_bot'],'4')

    async def test_folder_peer_inclusion_exclusion_and_dynamic_flags(self):
        peer=lambda value:types.SimpleNamespace(user_id=value)
        rule=types.SimpleNamespace(include_peers=[peer(1)],pinned_peers=[peer(2)],exclude_peers=[peer(3)],bots=False)
        dialog=lambda value:types.SimpleNamespace(entity=types.SimpleNamespace(id=value,bot=True),archived=False,unread_count=0)
        self.assertTrue(allinone.dialog_in_filter(dialog(1),rule))
        self.assertTrue(allinone.dialog_in_filter(dialog(2),rule))
        self.assertFalse(allinone.dialog_in_filter(dialog(3),rule))
        self.assertFalse(allinone.dialog_in_filter(dialog(4),rule))
        rule.bots=True
        self.assertTrue(allinone.dialog_in_filter(dialog(4),rule))
        rule.exclude_read=True
        self.assertFalse(allinone.dialog_in_filter(dialog(4),rule))

    async def test_random_gap_and_independent_bot_excluded_from_batch(self):
        class Client:
            async def connect(self): pass
            async def disconnect(self): pass
            async def is_user_authorized(self): return True
        user={'name':'Offline','session':'one','api_id':1,'api_hash':'offline','bot_schedules':{'@own_bot':{'enabled':True}}}
        called=[]
        async def execute(signer,bot):
            called.append(bot); signer.result='🎉 签到成功'; return True
        with patch.object(allinone,'TelegramClient',return_value=Client()), patch.object(allinone,'install_handlers'), patch.object(allinone,'get_account_bots',AsyncMock(return_value=['@first_bot','@own_bot','@last_bot'])), patch.object(allinone,'run_signer_once',execute), patch.object(allinone,'get_bot_display_name',AsyncMock(return_value='Bot')), patch.object(allinone,'mark_all_read',AsyncMock()), patch.object(allinone.asyncio,'sleep',AsyncMock()) as sleep, patch.object(allinone.random,'randint',return_value=10) as randint:
            with contextlib.redirect_stdout(io.StringIO()): await allinone.run_user(user,'',[],[],{})
            self.assertEqual(called,['@first_bot','@last_bot'])
            randint.assert_called_once_with(5,15); sleep.assert_awaited_once_with(10)
            called.clear(); sleep.reset_mock()
            with contextlib.redirect_stdout(io.StringIO()): await allinone.run_user(user,'',[],[],{},only_bot='@own_bot')
            self.assertEqual(called,['@own_bot']); sleep.assert_not_awaited()


if __name__=='__main__': unittest.main()
