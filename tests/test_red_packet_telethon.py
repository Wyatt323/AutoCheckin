"""Real Telethon events/buttons with intercepted RPCs; no Telegram connection."""
import asyncio
import contextlib
import datetime as dt
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from network_guard import install_network_guard
install_network_guard()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import telethon
from telethon import functions, types, utils
import automation_worker as worker
from red_packet import claim_button

CHAT = -1003403977616
CHANNEL = 3403977616


class OfflineClient:
    instances = []

    def __init__(self, *args, **kwargs):
        self._self_id = 100
        self._mb_entity_cache = SimpleNamespace(get=lambda _: None)
        self.handlers, self.calls = [], []
        self.answer = '领取成功'
        self.chat = types.Channel(CHANNEL, 'NiuBi-Emby', types.ChatPhotoEmpty(),
                                  dt.datetime.now(dt.timezone.utc), megagroup=True, access_hash=123)
        self.bot = types.User(200, bot=True, username='niubi2233_bot', access_hash=456)
        self.member = types.User(300, first_name='Other member', access_hash=789)
        self.entities = {CHAT: self.chat, 200: self.bot, 300: self.member}
        self.disconnected = False
        self.instances.append(self)

    async def connect(self):
        pass

    async def is_user_authorized(self):
        return True

    async def get_entity(self, value):
        return self.chat

    async def get_input_entity(self, value):
        return utils.get_input_peer(value if isinstance(value, types.Channel) else self.chat)

    async def get_messages(self, *args, **kwargs):
        return []

    def add_event_handler(self, handler, builder):
        self.handlers.append((handler, builder))

    async def __call__(self, request):
        if not isinstance(request, functions.messages.GetBotCallbackAnswerRequest):
            raise AssertionError(f'Unexpected Telegram RPC: {type(request).__name__}')
        self.calls.append(request)
        return types.messages.BotCallbackAnswer(cache_time=0, message=self.answer)

    async def disconnect(self):
        self.disconnected = True

    async def dispatch(self, message, edited=False):
        update_type = types.UpdateEditChannelMessage if edited else types.UpdateNewChannelMessage
        update = update_type(message=message, pts=1, pts_count=1)
        for handler, builder in self.handlers:
            await builder.resolve(self)
            event = builder.build(update, self_id=self._self_id)
            if event is None:
                continue
            event._entities = self.entities
            event._set_client(self)
            if builder.filter(event):
                await handler(event)

    def message(self, id, text='', *, button_type=None, reply=None, member=False, chat=CHANNEL):
        markup = None
        if button_type is not None:
            markup = types.ReplyInlineMarkup(rows=[types.KeyboardInlineButtonRow(buttons=[
                types.KeyboardInlineButton(text='👆 好運連連', type=button_type)])])
        return types.Message(id=id, peer_id=types.PeerChannel(chat),
            from_id=types.PeerUser(300 if member else 200), out=False,
            date=dt.datetime.now(dt.timezone.utc), message=text, reply_markup=markup,
            reply_to=types.MessageReplyHeader(reply_to_msg_id=reply) if reply else None)


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


class RealTelethonPacketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.logs, self.patches = [], contextlib.ExitStack()
        ready = asyncio.Event()
        def emit(text, level='info', kind='log', **metadata):
            self.logs.append({'text': text, 'kind': kind, **metadata})
            if kind == 'ready':
                ready.set()
        config = {'telegram': {'users': [{'name': 'Labubu', 'session': 'Labubu',
            'api_id': 123, 'api_hash': 'offline'}]}, 'automations': {'redPackets': [{
            'id': 'real_sdk_rule', 'name': '真实SDK测试', 'enabled': True, 'account': 'Labubu',
            'groups': [str(CHAT)], 'botUsername': '@niubi2233_bot',
            'watchSeconds': 120, 'retryInterval': 0.5}]}}
        for target, values in [(telethon, {'TelegramClient': OfflineClient}), (worker, {
            'load_config': lambda: config, 'emit': emit, 'read_document': lambda *a, **kw: {},
            'write_document': lambda *a, **kw: None, 'save_sent': lambda *a, **kw: None,
            'load_state': lambda: {'sent': {}, 'planned': {}, 'claimed': {}},
            'telegram_proxy_kwargs': lambda user: {}})]:
            self.patches.enter_context(patch.multiple(target, **values))
        self.task = asyncio.create_task(worker.main())
        await asyncio.wait_for(ready.wait(), 2)
        self.client = OfflineClient.instances[-1]

    async def asyncTearDown(self):
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task
        self.patches.close()
        self.assertTrue(self.client.disconnected)

    async def test_other_member_red_prefix_uses_real_callback_rpc(self):
        for index, command in enumerate(['/red 66 10', '/red 100 1', '/red@niubi2233_bot 66 10', '/red66 10']):
            with self.subTest(command=command):
                id = 10 + index * 10
                await self.client.dispatch(self.client.message(id, command, member=True))
                await self.client.dispatch(self.client.message(id+1, '🧧 牛币红包', reply=id,
                    button_type=types.InlineButtonTypeCallback(data=b'claim-real')))
                await settle()
                self.assertEqual(len(self.client.calls), index+1)
                request = self.client.calls[-1]
                self.assertEqual(request.data, b'claim-real')
                self.assertEqual(request.msg_id, id+1)
                self.assertEqual(utils.get_peer_id(request.peer), CHAT)
        self.assertEqual(sum('发现 /red' in entry['text'] for entry in self.logs), 4)
        self.assertEqual(sum('领取成功或已领取' in entry['text'] for entry in self.logs), 4)

    async def test_real_edit_preparation_becomes_callback_button(self):
        await self.client.dispatch(self.client.message(10, '/red 66 10', member=True))
        await self.client.dispatch(self.client.message(11, '正在准备红包，稍等', reply=10))
        await self.client.dispatch(self.client.message(11, '🧧 牛币红包', reply=10,
            button_type=types.InlineButtonTypeCallback(data=b'edited')), edited=True)
        await settle()
        self.assertEqual([request.data for request in self.client.calls], [b'edited'])

    async def test_real_bot_packet_without_command_event(self):
        await self.client.dispatch(self.client.message(11, '🧧 牛币红包', reply=10,
            button_type=types.InlineButtonTypeCallback(data=b'missed-command')))
        await settle()
        self.assertEqual([request.data for request in self.client.calls], [b'missed-command'])
        self.assertTrue(any('直接检测到 Bot 红包' in entry['text'] for entry in self.logs))

    async def test_real_exhausted_edit_stops_retry(self):
        self.client.answer = '正在领取'
        await self.client.dispatch(self.client.message(10, '/red 100 1', member=True))
        await self.client.dispatch(self.client.message(11, '🧧 牛币红包', reply=10,
            button_type=types.InlineButtonTypeCallback(data=b'claim')))
        await settle()
        await self.client.dispatch(self.client.message(11, 'Wyatt的红包已经被抢光啦~', reply=10), edited=True)
        await asyncio.sleep(0.6)
        self.assertEqual(len(self.client.calls), 1)
        self.assertTrue(any('红包已领完或失效' in entry['text'] for entry in self.logs))

    async def test_real_noncallback_password_and_unrelated_group_ignored(self):
        for kind in [types.InlineButtonTypeUrl('https://example.invalid'),
                     types.InlineButtonTypeBuy(), types.InlineButtonTypeGame(),
                     types.InlineButtonTypeCallback(data=b'password', requires_password=True)]:
            message = self.client.message(11, '红包', button_type=kind)
            message._finish_init(self.client, self.client.entities, None)
            self.assertIsNone(claim_button(message, {}), type(kind).__name__)
            await self.client.dispatch(message)
        regular = self.client.message(12, '红包')
        regular.reply_markup = types.ReplyKeyboardMarkup(rows=[types.KeyboardButtonRow(buttons=[
            types.KeyboardButton('领取红包', types.ButtonTypeDefault())])])
        regular._finish_init(self.client, self.client.entities, None)
        self.assertIsNone(claim_button(regular, {}))
        await self.client.dispatch(regular)
        await self.client.dispatch(self.client.message(13, '红包', chat=12345,
            button_type=types.InlineButtonTypeCallback(data=b'other-chat')))
        await settle()
        self.assertEqual(self.client.calls, [])


if __name__ == '__main__':
    unittest.main()
