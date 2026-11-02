"""Offline reply receipts with real Telethon peers and event filters."""
import asyncio
import datetime as dt
import sys
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

from network_guard import install_network_guard
install_network_guard()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from telethon import types
from scheduled_reply_reads import ScheduledReplyReader


class Client:
    def __init__(self):
        self._self_id = 100
        self._mb_entity_cache = SimpleNamespace(get=lambda _: None)
        self.handlers, self.reads, self.errors = [], [], []
        self.gate = None

    def add_event_handler(self, handler, builder):
        self.handlers.append((handler, builder))

    def remove_event_handler(self, handler):
        self.handlers = [(callback, builder) for callback, builder in self.handlers if callback != handler]

    async def send_read_acknowledge(self, target, *, max_id):
        self.reads.append((target, max_id))
        if self.errors:
            raise self.errors.pop(0)
        if self.gate:
            await self.gate.wait()

    async def dispatch(self, id, *, chat=200, out=False):
        message = types.Message(id=id, peer_id=types.PeerUser(chat),
                                from_id=types.PeerUser(100 if out else chat), out=out,
                                date=dt.datetime.now(dt.timezone.utc), message='Bot reply')
        update = types.UpdateNewMessage(message=message, pts=1, pts_count=1)
        for handler, builder in list(self.handlers):
            await builder.resolve(self)
            event = builder.build(update, self_id=self._self_id)
            event._entities = {}
            event._set_client(self)
            if builder.filter(event):
                await handler(event)


class ScheduledReplyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client, self.logs = Client(), []
        self.reader = ScheduledReplyReader(self.client, lambda *a, **kw: self.logs.append((a, kw)),
                                           window_seconds=2, debounce_seconds=.005)
        self.target = types.InputPeerUser(200, 123)
        self.rule = {'id': 'schedule', 'account': 'first', 'target': '@test_bot'}

    async def asyncTearDown(self):
        await self.reader.close()
        self.assertFalse(self.reader.tasks)
        self.assertFalse(self.reader.watches)
        self.assertFalse(self.client.handlers)

    def sent(self, rule=None):
        rule = rule or self.rule
        watch = self.reader.begin(rule, self.target)
        self.reader.sent(watch, rule)
        return watch

    async def test_delayed_and_multiple_replies(self):
        self.sent()
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [])
        await self.client.dispatch(11)
        await self.client.dispatch(12)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [(self.target, 12)])
        await self.client.dispatch(13)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [(self.target, 12), (self.target, 13)])
        self.assertEqual(self.logs[-1][0][0]['account'], 'first')

    async def test_reply_during_send_waits_for_send_success(self):
        watch = self.reader.begin(self.rule, self.target)
        await self.client.dispatch(11)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [])
        self.reader.sent(watch, self.rule)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [(self.target, 11)])

    async def test_failed_send_does_not_mark_reply_read(self):
        watch = self.reader.begin(self.rule, self.target)
        await self.client.dispatch(11)
        self.reader.failed(watch)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [])
        self.assertFalse(self.reader.watches)

    async def test_unrelated_chats_outgoing_and_duplicate_updates_ignored(self):
        self.sent()
        await self.client.dispatch(11, chat=300)
        await self.client.dispatch(12, out=True)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [])
        await self.client.dispatch(13)
        await asyncio.sleep(.03)
        await self.client.dispatch(13)
        await self.client.dispatch(12)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [(self.target, 13)])

    async def test_accounts_with_same_target_are_isolated(self):
        other = Client()
        reader = ScheduledReplyReader(other, lambda *a, **kw: None, debounce_seconds=.005)
        try:
            other_rule = {**self.rule, 'account': 'second'}
            watch = reader.begin(other_rule, self.target)
            reader.sent(watch, other_rule)
            self.sent()
            await self.client.dispatch(11)
            await asyncio.sleep(.03)
            self.assertEqual(self.client.reads, [(self.target, 11)])
            self.assertEqual(other.reads, [])
        finally:
            await reader.close()

    async def test_same_chat_rules_share_receipts_and_failed_send_preserves_window(self):
        watch = self.sent()
        other_rule = {**self.rule, 'id': 'other'}
        second = self.reader.begin(other_rule, self.target)
        self.assertIs(second, watch)
        self.reader.failed(second)
        await self.client.dispatch(11)
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [(self.target, 11)])
        self.assertEqual(self.logs[-1][0][0]['id'], 'schedule')

    async def test_replies_during_receipt_are_not_lost(self):
        self.client.gate = asyncio.Event()
        self.sent()
        await self.client.dispatch(11)
        await asyncio.sleep(.03)
        await self.client.dispatch(12)
        self.client.gate.set()
        await asyncio.sleep(.03)
        self.assertEqual(self.client.reads, [(self.target, 11), (self.target, 12)])

    async def test_floodwait_retries_read_only(self):
        class FloodWait(Exception):
            seconds = .01
        self.client.errors = [FloodWait('offline rate limit')]
        self.sent()
        await self.client.dispatch(11)
        await asyncio.sleep(1.15)
        self.assertEqual(self.client.reads, [(self.target, 11), (self.target, 11)])
        self.assertEqual(self.logs[0][0][3], 'warning')
        self.assertEqual(self.logs[0][1]['state'], 'completed')

    async def test_window_expires_and_cancels_pending_read(self):
        self.reader.window_seconds = .05
        self.client.gate = asyncio.Event()
        self.sent()
        await self.client.dispatch(11)
        await asyncio.sleep(.1)
        self.assertFalse(self.reader.watches)
        self.assertFalse(self.reader.tasks)
        await self.client.dispatch(12)
        self.assertEqual(self.client.reads, [(self.target, 11)])


class WorkerReplyTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_read_receipt_does_not_block_packet_callbacks(self):
        import contextlib
        import telethon
        import automation_worker as worker
        from test_red_packet_telethon import OfflineClient, CHAT, settle

        ready, reading, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        clients = []

        class SharedClient(OfflineClient):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.sent = []
                clients.append(self)

            async def get_input_entity(self, value):
                if value == '@reply_bot':
                    return types.InputPeerUser(999, 123)
                return await super().get_input_entity(value)

            async def send_message(self, target, message):
                self.sent.append((target, message))

            async def send_read_acknowledge(self, target, *, max_id=None):
                if max_id is not None:
                    reading.set()
                    await release.wait()

            def remove_event_handler(self, handler):
                self.handlers = [(callback, builder) for callback, builder in self.handlers if callback != handler]

        def emit(message, level='info', kind='log', **metadata):
            if kind == 'ready':
                ready.set()

        config = {'telegram': {'users': [{'name': 'test', 'api_id': 123, 'api_hash': 'offline'}]},
                  'automations': {
                      'schedules': [{'id': 'schedule', 'account': 'test', 'target': '@reply_bot',
                                     'message': '/sign', 'repeat': 'daily', 'time': '00:00'}],
                      'redPackets': [{'id': 'packet', 'account': 'test', 'groups': [str(CHAT)],
                                      'botUsername': '@niubi2233_bot', 'watchSeconds': 120, 'retryInterval': .5}]}}
        with patch.object(telethon, 'TelegramClient', SharedClient), \
                patch.object(worker, 'load_config', return_value=config), \
                patch.object(worker, 'load_state', return_value={'sent': {}, 'planned': {}, 'claimed': {}}), \
                patch.object(worker, 'read_document', return_value={}), \
                patch.object(worker, 'write_document'), patch.object(worker, 'save_sent'), \
                patch.object(worker, 'emit', side_effect=emit), \
                patch.object(worker, 'occurrence', return_value='due'):
            task = asyncio.create_task(worker.main())
            try:
                await asyncio.wait_for(ready.wait(), 2)
                await settle()
                client = clients[0]
                self.assertEqual(len(client.sent), 1)
                reply = types.Message(id=50, peer_id=types.PeerUser(999), from_id=types.PeerUser(999),
                                      out=False, date=dt.datetime.now(dt.timezone.utc), message='签到成功')
                await client.dispatch(reply)
                await asyncio.wait_for(reading.wait(), 2)
                await client.dispatch(client.message(10, '/red 66 10', member=True))
                await client.dispatch(client.message(11, '🧧 牛币红包', reply=10,
                    button_type=types.InlineButtonTypeCallback(data=b'claim')))
                await settle()
                self.assertEqual([request.data for request in client.calls], [b'claim'])
                self.assertFalse(client.disconnected)
                self.assertEqual(len(clients), 1, 'scheduled replies reuse the existing Telegram connection')
            finally:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            self.assertTrue(client.disconnected)
            self.assertEqual(len(client.handlers), 2, 'the reply reader removed only its own handler')


if __name__ == '__main__':
    unittest.main()
