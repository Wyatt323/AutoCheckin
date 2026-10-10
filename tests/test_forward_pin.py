"""Offline forwarding/pinning tests; no Telegram or live data."""
import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import offline_support
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation_worker as worker


def rule(**kwargs):
    return {'id': 'forward_pin_001', 'name': '重要消息', 'account': 'first',
            'sources': ['@source_one', '@source_two'], 'target': '@destination',
            'keywords': [], 'pinAfterForward': True, **kwargs}


class FloodWait(Exception):
    seconds = 1


class ForwardPinTests(unittest.IsolatedAsyncioTestCase):
    def test_literal_keyword_matching_and_captions(self):
        self.assertTrue(worker.matches_keywords(types.SimpleNamespace(raw_text=None), []))
        self.assertTrue(worker.matches_keywords(types.SimpleNamespace(raw_text='新品 SALE'), ['通知', 'sale']))
        self.assertTrue(worker.matches_keywords(types.SimpleNamespace(message='[重要] 图片说明'), ['[重要]']))
        self.assertFalse(worker.matches_keywords('重要通知', ['[重要]']))
        self.assertFalse(worker.matches_keywords(types.SimpleNamespace(raw_text='普通消息'), ['sale', '通知']))
        self.assertFalse(worker.matches_keywords(types.SimpleNamespace(raw_text=None), ['通知']))

    async def test_pin_target_message_and_switch(self):
        original, forwarded = types.SimpleNamespace(id=1), types.SimpleNamespace(id=200)
        client = types.SimpleNamespace(forward_messages=AsyncMock(return_value=forwarded), pin_message=AsyncMock())
        with patch.object(worker, 'emit') as emit:
            await worker.forward_message(rule(), client, '@destination', original, '@source_one')
        client.pin_message.assert_awaited_once_with('@destination', forwarded, notify=False)
        self.assertIn('已转发并置顶', emit.call_args.args[0])
        client.pin_message.reset_mock()
        await worker.forward_message(rule(pinAfterForward=False), client, '@destination', original, '@source_one')
        client.pin_message.assert_not_awaited()

    async def test_pin_rate_limit_does_not_repeat_forward(self):
        target = types.SimpleNamespace(id=200)
        client = types.SimpleNamespace(forward_messages=AsyncMock(return_value=[None, target]),
                                       pin_message=AsyncMock(side_effect=[FloodWait(), None]))
        with patch.object(worker.asyncio, 'sleep', AsyncMock()) as sleep, patch.object(worker, 'emit'):
            await worker.forward_message(rule(), client, 'target', object(), '@source_one')
        client.forward_messages.assert_awaited_once()
        self.assertEqual(client.pin_message.await_count, 2)
        self.assertIs(client.pin_message.call_args.args[1], target)
        sleep.assert_awaited_once_with(2)

    async def test_pin_permission_failure_preserves_forward_and_logs(self):
        client = types.SimpleNamespace(forward_messages=AsyncMock(return_value=types.SimpleNamespace(id=200)),
                                       pin_message=AsyncMock(side_effect=RuntimeError('no pin permission')))
        with patch.object(worker, 'emit') as emit:
            await worker.forward_message(rule(), client, 'target', object(), '@source_one')
        client.forward_messages.assert_awaited_once()
        self.assertIn('消息已转发', emit.call_args.args[0])
        self.assertIn('置顶失败', emit.call_args.args[0])
        self.assertEqual(emit.call_args.kwargs['state'], 'failed')
        self.assertEqual(emit.call_args.kwargs['account'], 'first')

    async def test_worker_multi_source_filters_and_account_isolation(self):
        clients, logs = {}, []
        ready = asyncio.Event()

        class Client:
            def __init__(self, session, *args, **kwargs):
                self.account = Path(session).name
                self.handlers, self.forwarded, self.pinned = [], [], []
                self.done = asyncio.Event()
                clients[self.account] = self
            async def connect(self): pass
            async def is_user_authorized(self): return True
            async def get_input_entity(self, value):
                if value == '@bad_source': raise ValueError('offline unavailable')
                return value
            def add_event_handler(self, handler, event): self.handlers.append((handler, event))
            async def forward_messages(self, target, message):
                self.forwarded.append((target, message))
                self.done.set()
                return types.SimpleNamespace(id=200)
            async def pin_message(self, target, message, **kwargs): self.pinned.append((target, message.id, kwargs))
            async def disconnect(self): pass

        def emit(message, level='info', kind='log', **metadata):
            logs.append({'message': message, **metadata})
            if kind == 'ready': ready.set()

        config = {'telegram': {'users': [dict(name=name, session=name, api_id=123, api_hash='offline') for name in ('first', 'second')]},
                  'automations': {'forwardPins': [rule(sources=['@source_one', '@source_two', '@bad_source'], keywords=['通知']),
                                                 rule(id='forward_pin_002', account='second', pinAfterForward=False),
                                                 rule(id='disabled_001', account='absent', enabled=False)]}}
        with patch.object(sys.modules['telethon'], 'TelegramClient', Client), patch.object(worker, 'load_config', return_value=config), \
                patch.object(worker, 'load_state', return_value={'sent': {}, 'planned': {}, 'claimed': {}}), \
                patch.object(worker, 'save_sent'), patch.object(worker, 'emit', side_effect=emit):
            task = asyncio.create_task(worker.main())
            try:
                await asyncio.wait_for(ready.wait(), 1)
                self.assertEqual(set(clients), {'first', 'second'})
                self.assertEqual(clients['first'].handlers[0][1]['chats'], ['@source_one', '@source_two'])
                await clients['first'].handlers[0][0](types.SimpleNamespace(message=types.SimpleNamespace(raw_text='普通内容')))
                await clients['first'].handlers[0][0](types.SimpleNamespace(message=types.SimpleNamespace(raw_text='更新通知')))
                await clients['second'].handlers[0][0](types.SimpleNamespace(message=types.SimpleNamespace(raw_text=None)))
                await asyncio.wait_for(asyncio.gather(*(client.done.wait() for client in clients.values())), 1)
                self.assertEqual(len(clients['first'].forwarded), 1)
                self.assertEqual(len(clients['second'].forwarded), 1)
                self.assertEqual(clients['first'].pinned, [('@destination', 200, {'notify': False})])
                self.assertEqual(clients['second'].pinned, [])
                results = [log for log in logs if '已转发' in log['message']]
                self.assertEqual({log['account'] for log in results}, {'first', 'second'})
                self.assertEqual({log['ruleId'] for log in results}, {'forward_pin_001', 'forward_pin_002'})
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task


if __name__ == '__main__':
    unittest.main()
