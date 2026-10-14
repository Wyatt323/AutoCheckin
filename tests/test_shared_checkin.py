"""Real Telegram event/button types with offline RPCs and the real signer."""
import asyncio
import contextlib
import datetime as dt
import io
import json
import os
import queue
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_red_packet_telethon import OfflineClient, CHAT, settle
import allinone
import automation_worker as worker
import checkin_logging as logging
from telethon import types
from red_packet import RedPacketMonitor


class SharedClient(OfflineClient):
    def __init__(self):
        super().__init__()
        self.connected = True
        self.sent = asyncio.Event()
        self.release = asyncio.Event()
        self.sent_count = 0
        self.sign_bot = types.User(500, bot=True, username='checkin_bot', first_name='签到 Bot', access_hash=999)
        self.entities[500] = self.sign_bot
        self.entities[100] = types.User(100, first_name='Me', access_hash=888)

    def is_connected(self):
        return self.connected

    def on(self, builder):
        if isinstance(builder, type):
            builder = builder()
        def register(handler):
            self.add_event_handler(handler, builder)
            return handler
        return register

    def remove_event_handler(self, handler):
        self.handlers = [(fn, event) for fn, event in self.handlers if fn is not handler]

    async def iter_dialogs(self, **kwargs):
        yield SimpleNamespace(entity=self.sign_bot)

    async def send_message(self, bot, text):
        self.sent_count += 1
        self.sent.set()
        await self.release.wait()

    async def send_read_acknowledge(self, bot):
        pass

    async def get_entity(self, value):
        return self.sign_bot

    async def dispatch(self, message, edited=False):
        from telethon import types
        update_type = types.UpdateNewMessage if isinstance(message.peer_id, types.PeerUser) else types.UpdateNewChannelMessage
        if edited:
            update_type = types.UpdateEditChannelMessage
        update = update_type(message=message, pts=1, pts_count=1)
        for handler, builder in list(self.handlers):
            await builder.resolve(self)
            event = builder.build(update, self_id=self._self_id)
            if event is not None:
                event._entities = self.entities
                event._set_client(self)
                if builder.filter(event):
                    await handler(event)


class SharedCheckinTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = SharedClient()
        self.control = worker.CheckinControl({'Labubu': self.client})
        self.events, self.packet_logs = [], []
        self.config = {'telegram': {'users': [{'name': 'Labubu', 'session': 'Labubu', 'api_id': 123,
            'api_hash': 'offline', 'bot_groups': {'command': [{'bot': '@checkin_bot', 'command': '/sign'}]}}]}, 'ai': {}}
        self.patches = contextlib.ExitStack()
        self.patches.enter_context(patch.object(self.control, 'send', side_effect=lambda id, event: self.events.append({'request': id, **event})))
        self.patches.enter_context(patch.object(allinone, 'read_document', return_value=self.config))
        self.factory = self.patches.enter_context(patch.object(allinone, 'TelegramClient', side_effect=AssertionError('never open another Session')))
        self.patches.enter_context(patch.object(sys, 'stdout', logging.ScopedOutput(io.StringIO(), 'stdout', passthrough=True)))
        self.monitor = RedPacketMonitor(self.client, 'Labubu', {CHAT: {'peer': self.client.chat, 'title': 'Group', 'rules': [{
            'id': 'packet_rule', 'account': 'Labubu', 'botUsername': '@niubi2233_bot', 'watchSeconds': 60,
            'retryInterval': 0.5}]}}, lambda text, level='info', **event: self.packet_logs.append(text), {}, lambda: asyncio.sleep(0))
        from telethon import events
        self.client.add_event_handler(self.monitor.handle, events.NewMessage(chats=[CHAT]))

    async def asyncTearDown(self):
        await self.control.close()
        await self.monitor.close()
        self.patches.close()
        self.factory.assert_not_called()
        self.assertFalse(self.client.disconnected, 'finishing/cancelling sign-in must not close the listener')
        self.assertEqual(len(self.client.handlers), 1, 'signer handlers removed; packet listener retained')

    def start(self, id='shared_run_001', **kwargs):
        self.control.dispatch({'type': 'checkin', 'id': id, 'accounts': ['Labubu'], 'scheduled': False, **kwargs})

    async def packet(self, id):
        await self.client.dispatch(self.client.message(id, '/red 66 10', member=True))
        await self.client.dispatch(self.client.message(id+1, '🧧 牛币红包', reply=id,
            button_type=types.InlineButtonTypeCallback(data=b'claim-shared')))
        await settle()

    async def test_packet_claim_during_wait_and_private_results_stay_scoped(self):
        self.start()
        await asyncio.wait_for(self.client.sent.wait(), 2)
        await self.packet(10)
        self.assertEqual(len(self.client.calls), 1)
        self.assertTrue(self.control.jobs, 'checkin is still waiting while packet was claimed')
        result = types.Message(id=100, peer_id=types.PeerUser(100), from_id=types.PeerUser(500), out=False,
            date=dt.datetime.now(dt.timezone.utc), message='签到成功')
        await self.client.dispatch(result)
        self.client.release.set()
        await asyncio.wait_for(self.control.jobs['shared_run_001']['task'], 2)
        self.assertEqual(self.events[-1]['code'], 0)
        self.assertTrue(any(e['type'] == 'bot_result' and e['status'] == 'success' for e in self.events))
        self.assertTrue(any(e['type'] == 'checkin_log' and '📩 签到成功' in e['text'] and e['account'] == 'Labubu' for e in self.events))
        self.assertFalse(any('发现 /red' in e.get('text', '') for e in self.events))
        await self.packet(20)
        self.assertEqual(len(self.client.calls), 2, 'listener continues after signer completion')

    async def test_cancel_signer_keeps_packet_listener_and_deduplicates_commands(self):
        self.start();await asyncio.wait_for(self.client.sent.wait(), 2)
        self.start('shared_run_duplicate')
        self.assertEqual(self.events[-1]['code'], 1, 'worker enforces per-account exclusion')
        task = self.control.jobs['shared_run_001']['task']
        self.control.dispatch({'type': 'cancel_checkin', 'id': 'shared_run_001'})
        await asyncio.wait_for(task, 2)
        self.assertEqual(self.events[-1]['code'], 130)
        self.start();await settle();self.assertEqual(self.client.sent_count, 1, 'duplicate run IDs never send twice')
        await self.packet(30);self.assertEqual(len(self.client.calls), 1)

    async def test_cancel_before_first_task_step_releases_job(self):
        self.start()
        self.control.dispatch({'type': 'cancel_checkin', 'id': 'shared_run_001'})
        await settle()
        self.assertEqual(self.control.jobs, {})
        self.assertEqual(self.events[-1]['code'], 130)
        self.assertEqual(self.client.sent_count, 0)


class SharedControlPipeTests(unittest.TestCase):
    def test_actual_stdin_protocol_logs_cancellation_and_parent_exit(self):
        # Exercise the actual daemon reader and mixed JSON output in a separate
        # process; fake only the signer/RPCs, never connect to Telegram.
        script = '''
import asyncio, sys, types
from automation_worker import CheckinControl, emit
from checkin_logging import install_json_output, account_log, emit_result, emit_bot_result
client = object()
async def sign(*, bot, scheduled, parallel, clients, accounts):
    assert clients == {'Labubu': client} and accounts == ['Labubu']
    with account_log('Labubu'):
        print('signer started')
        emit('listener remains active', account='Labubu', category='red_packet')
        await asyncio.sleep(0.01 if bot == '@complete' else 60)
        emit_bot_result('Labubu', '@complete', 'Complete', '', '签到成功')
        emit_result('Labubu', True)
    return True
signer = types.ModuleType('allinone')
signer.main = sign
sys.modules['allinone'] = signer
async def run():
    control = CheckinControl({'Labubu': client})
    control.start()
    emit('ready', kind='ready')
    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        pass
    finally:
        await control.close()
        emit('closed', kind='closed')
install_json_output(passthrough=True)
asyncio.run(run())
'''
        env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
        process = subprocess.Popen([sys.executable, '-u', '-c', script], cwd=Path(__file__).resolve().parent.parent,
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8')
        events = queue.Queue()
        def read():
            for line in process.stdout:
                try:
                    events.put(json.loads(line))
                except ValueError:
                    events.put({'invalid': line})
            events.put({'eof': True})
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        def send(command):
            process.stdin.write(json.dumps(command) + '\n')
            process.stdin.flush()
        def event():
            value = events.get(timeout=10)
            self.assertNotIn('invalid', value)
            self.assertNotIn('eof', value, 'worker exited before the expected protocol event')
            return value
        def start(request, bot=None):
            send({'type': 'checkin', 'id': request, 'accounts': ['Labubu'], 'bot': bot, 'scheduled': False})
            value = event()
            self.assertEqual(value['type'], 'checkin')
            self.assertEqual(value['requestId'], request)
            self.assertEqual(value['event']['account'], 'Labubu')
            self.assertEqual(value['event']['text'], 'signer started')
            self.assertEqual(event()['category'], 'red_packet', 'listener JSON stays outside the signer envelope')
        try:
            self.assertEqual(event()['type'], 'ready')
            start('pipe_cancel_001')
            send({'type': 'cancel_checkin', 'id': 'pipe_cancel_001'})
            self.assertEqual(event()['event'], {'type': 'finished', 'code': 130})
            start('pipe_complete_002', '@complete')
            for kind in ('bot_result', 'account_result', 'finished'):
                value = event()
                self.assertEqual(value['requestId'], 'pipe_complete_002')
                self.assertEqual(value['event']['type'], kind)
            self.assertEqual(value['event']['code'], 0)
            # Losing the parent pipe cancels active jobs and exits the listener.
            start('pipe_eof_003')
            process.stdin.close()
            self.assertEqual(event()['event'], {'type': 'finished', 'code': 130})
            self.assertEqual(event()['type'], 'closed')
            self.assertEqual(process.wait(timeout=10), 0)
            self.assertEqual(process.stderr.read(), '')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            reader.join(timeout=5)
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()


if __name__ == '__main__':
    unittest.main()
