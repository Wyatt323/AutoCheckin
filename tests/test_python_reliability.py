"""Offline regressions: python3 -m unittest discover -s tests -p 'test_*.py' -v."""
import asyncio
import datetime as dt
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from offline_support import TEMP_ROOT
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import allinone as signer
import automation_worker as worker


class ConfigTests(unittest.TestCase):
    def test_ocr_is_loaded_only_when_needed_and_reused(self):
        self.assertIsNone(signer.ocr, 'importing the signer must not initialize OCR')
        model = types.SimpleNamespace(classification=lambda value: 'ABCD')
        with patch.object(signer, 'ocr', None), patch('ddddocr.DdddOcr', return_value=model) as factory:
            self.assertIs(signer.get_ocr(), model)
            self.assertIs(signer.get_ocr(), model)
            factory.assert_called_once()

    def test_json_strings_are_not_rewritten(self):
        data = {'message': 'keep ,} and , ] and \\" and # and \\ paths', 'values': [',}', ', ]']}
        for parser in (signer.parse_config_text, worker.parse_config_text):
            self.assertEqual(parser(json.dumps(data)), data)

    def test_comments_and_trailing_commas(self):
        source = '# header\n{\n "message": "#literal ,}",\n "items": [1, 2,\n # comment\n ],\n # final\n}\n'
        for parser in (signer.parse_config_text, worker.parse_config_text):
            self.assertEqual(parser(source), {'message': '#literal ,}', 'items': [1, 2]})

    def test_invalid_json_is_still_rejected(self):
        for parser in (signer.parse_config_text, worker.parse_config_text):
            for text in ('{"a":1,,}', '{"a":"unterminated}', '{"a":1 # inline\n}'):
                with self.assertRaises(json.JSONDecodeError):
                    parser(text)

    def test_bad_state_shape(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            state = Path(directory) / 'state.json'
            with patch.object(worker, 'STATE_PATH', state):
                for content in ('null', '{"sent":null}', '{"sent":[]}', '{"sent":"bad"}', '{'):
                    state.write_text(content)
                    self.assertEqual(worker.load_sent(), {})
                worker.save_sent({'test': 'done'})
                self.assertEqual(worker.load_sent(), {'test': 'done'})

    def test_occurrence_boundaries(self):
        now = dt.datetime(2026, 1, 1, 10, 0, tzinfo=worker.CHINA_TIME)
        once = {'repeat': 'once', 'time': '2026-01-01T10:00'}
        daily = {'repeat': 'daily', 'time': '10:00'}
        self.assertIsNone(worker.occurrence(once, now - dt.timedelta(seconds=1)))
        self.assertEqual(worker.occurrence(once, now + dt.timedelta(seconds=299)), once['time'])
        self.assertIsNone(worker.occurrence(once, now + dt.timedelta(seconds=300)))
        self.assertEqual(worker.occurrence(daily, now), '2026-01-01')
        self.assertIsNone(worker.occurrence(daily, now + dt.timedelta(minutes=1)))


class SignerTests(unittest.IsolatedAsyncioTestCase):
    async def test_bot_exception_does_not_abort_batch(self):
        item = signer.BotSigner(types.SimpleNamespace(send_message=AsyncMock(side_effect=RuntimeError('offline failure'))), [], 'mock', '@bot', '/sign')
        self.assertFalse(await signer.run_signer_once(item, '@bot'))
        self.assertTrue(item.done)
        self.assertFalse(item.active)

    async def test_signer_cancellation_is_propagated(self):
        entered = asyncio.Event()
        async def send(*args):
            entered.set()
            await asyncio.Event().wait()
        item = signer.BotSigner(types.SimpleNamespace(send_message=send), [], 'mock', '@bot', '/sign')
        task = asyncio.create_task(signer.run_signer_once(item, '@bot'))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(item.active)

    async def test_retry_flag_restored_after_failure(self):
        item = signer.BotSigner(None, [], 'mock', '@bot')
        item.active = True
        item.check_recent_result = AsyncMock(side_effect=RuntimeError('failed'))
        with patch.object(signer.asyncio, 'sleep', AsyncMock()):
            with self.assertRaises(RuntimeError):
                await item.retry_run()
        self.assertFalse(item.retrying)

    async def test_retry_does_not_restart_finished_signer(self):
        item = signer.BotSigner(None, [], 'mock', '@bot')
        item.active = True
        item.start = AsyncMock()
        async def finish(*args):
            item.done = True
        with patch.object(signer.asyncio, 'sleep', finish):
            await item.retry_run()
        item.start.assert_not_awaited()
        self.assertFalse(item.retrying)

    async def test_folder_text_with_entities(self):
        client = AsyncMock(return_value=[types.SimpleNamespace(id=7, title=types.SimpleNamespace(text='Bots'))])
        self.assertEqual(await signer.resolve_dialog_folder(client, 'Bots'), 7)
        self.assertEqual(await signer.resolve_dialog_folder(client, '8'), 8)

    async def test_handler_case_and_at_prefix_and_stale_events(self):
        handlers = []
        class Client:
            def on(self, event):
                def register(handler):
                    handlers.append(handler)
                    return handler
                return register
        item = signer.BotSigner(None, [], 'mock', 'Mixed_Bot')
        item.active = True
        item.attempt_started_at = dt.datetime.now(dt.timezone.utc)
        signer.install_handlers(Client(), {'Mixed_Bot': item})
        event = types.SimpleNamespace(get_sender=AsyncMock(return_value=types.SimpleNamespace(username='mixed_bot')), raw_text='签到成功', message=types.SimpleNamespace(date=item.attempt_started_at - dt.timedelta(minutes=1)))
        await handlers[0](event)
        self.assertFalse(item.done)
        event.message.date = item.attempt_started_at
        await handlers[0](event)
        self.assertTrue(item.is_success())

    async def test_connection_failure_disconnects(self):
        client = types.SimpleNamespace(connect=AsyncMock(side_effect=RuntimeError('offline connect')), disconnect=AsyncMock())
        user = {'name': 'test', 'session': 'test', 'api_id': 1, 'api_hash': 'dummy'}
        with patch.object(signer, 'TelegramClient', return_value=client), patch.object(signer, 'install_handlers'):
            with self.assertRaises(RuntimeError):
                await signer.run_user(user, 'mock', [], [], {})
        client.disconnect.assert_awaited_once()

    async def test_captcha_memory_download_and_configured_length(self):
        now = dt.datetime.now(dt.timezone.utc)
        message = types.SimpleNamespace(date=now, photo=True, download_media=AsyncMock(return_value=b'offline image'))
        class Client:
            async def iter_messages(self, *args, **kwargs):
                yield message
        item = signer.BotSigner(Client(), [], 'mock', '@bot')
        item.active = True
        event = types.SimpleNamespace(respond=AsyncMock())
        with patch.object(signer, 'recognize_captcha', return_value='ABCDE'), patch.object(signer, 'CAPTCHA_LENGTH', 5):
            self.assertTrue(await item.handle_captcha(event))
        message.download_media.assert_awaited_once_with(file=bytes)
        event.respond.assert_awaited_once_with('ABCDE')

    async def test_ai_does_not_block_event_loop(self):
        import threading
        started, release = threading.Event(), threading.Event()
        def solve(*args, **kwargs):
            started.set()
            release.wait(2)
            return ['山']
        item = signer.BotSigner(None, [], 'mock', '@bot')
        item.active = True
        item.wait_poem_buttons = AsyncMock(return_value={'山': object()})
        with patch.object(signer, 'solve_poem_ai_with_fallback', solve):
            task = asyncio.create_task(item.handle_poem(types.SimpleNamespace(), '░'))
            try:
                for _ in range(100):
                    if started.is_set():
                        break
                    await asyncio.sleep(.001)
                self.assertTrue(started.is_set())
                self.assertFalse(task.done())
                item.done = True
            finally:
                release.set()
                await task
        self.assertFalse(item.verifying)


class WorkerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_awaits_schedule_before_disconnect(self):
        entered = asyncio.Event()
        order = []
        class Client:
            def __init__(self, *args, **kwargs):
                pass
            async def connect(self):
                pass
            async def is_user_authorized(self):
                return True
            async def get_input_entity(self, target):
                return target
            async def send_message(self, *args):
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    order.append('send finished')
            async def disconnect(self):
                order.append('disconnected')
        config = {'telegram': {'users': [{'name': 'test', 'api_id': 1, 'api_hash': 'dummy'}]}, 'automations': {'schedules': [{'id': 's', 'account': 'test', 'target': '@target', 'message': 'offline', 'repeat': 'daily', 'time': '00:00'}]}}
        with patch.object(sys.modules['telethon'], 'TelegramClient', Client), patch.object(worker, 'load_config', return_value=config), patch.object(worker, 'load_sent', return_value={}), patch.object(worker, 'occurrence', return_value='due'):
            task = asyncio.create_task(worker.main())
            try:
                await asyncio.wait_for(entered.wait(), 1)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        self.assertEqual(order, ['send finished', 'disconnected'])

    async def test_cancel_during_connect_disconnects(self):
        entered = asyncio.Event()
        disconnected = []
        class Client:
            def __init__(self, *args, **kwargs):
                pass
            async def connect(self):
                entered.set()
                await asyncio.Event().wait()
            async def disconnect(self):
                disconnected.append(True)
        config = {'telegram': {'users': [{'name': 'test', 'api_id': 1, 'api_hash': 'dummy'}]}, 'automations': {'schedules': [{'account': 'test'}]}}
        with patch.object(sys.modules['telethon'], 'TelegramClient', Client), patch.object(worker, 'load_config', return_value=config), patch.object(worker, 'load_sent', return_value={}):
            task = asyncio.create_task(worker.main())
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(disconnected, [True])


if __name__ == '__main__':
    unittest.main()
