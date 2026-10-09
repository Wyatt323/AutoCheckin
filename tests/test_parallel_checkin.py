"""Offline tests for the actual Python batch concurrency, with no Telegram traffic."""
import asyncio
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path
from unittest.mock import patch

import offline_support
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import allinone


class ParallelCheckin(unittest.IsolatedAsyncioTestCase):
    def test_ocr_initialization_and_inference_are_safe_across_threads(self):
        entered, release = threading.Event(), threading.Event()
        stdout, stderr = sys.stdout, sys.stderr
        model = object()

        def factory(**kwargs):
            entered.set()
            release.wait(2)
            return model

        with patch.object(allinone, 'ocr', None), patch('ddddocr.DdddOcr', side_effect=factory) as initialize, ThreadPoolExecutor(2) as executor:
            first = executor.submit(allinone.get_ocr)
            self.assertTrue(entered.wait(1))
            second = executor.submit(allinone.get_ocr)
            try:
                self.assertIs(sys.stdout, stdout)
                self.assertIs(sys.stderr, stderr)
            finally:
                release.set()
            self.assertIs(first.result(), model)
            self.assertIs(second.result(), model)
            initialize.assert_called_once_with(show_ad=False)

        active, maximum = 0, 0

        class Classifier:
            def classification(self, data):
                nonlocal active, maximum
                active += 1
                maximum = max(maximum, active)
                time.sleep(0.03)
                active -= 1
                return 'ABCD'

        with patch.object(allinone, 'ocr', Classifier()), patch.object(allinone, 'preprocess_captcha_variants', return_value=[b'fake']), ThreadPoolExecutor(2) as executor:
            self.assertEqual(list(executor.map(allinone.recognize_captcha, ['first', 'second'])), ['ABCD', 'ABCD'])
        self.assertEqual(maximum, 1, 'shared model inference must not overlap')

    async def test_accounts_overlap_and_failure_does_not_cancel_others(self):
        users = [dict(session=name, name=name, bots=['@offline_bot'], bot_commands={}, dialog_folder=None)
                 for name in ('first', 'second')]
        entered = set()
        both_entered = asyncio.Event()
        results = {}

        async def execute(user, *args, **kwargs):
            entered.add(user['session'])
            if len(entered) == 2:
                both_entered.set()
            await asyncio.wait_for(both_entered.wait(), 1)
            if user['session'] == 'first':
                raise RuntimeError('offline failure')
            await asyncio.sleep(0)
            return True

        with patch.object(allinone, 'load_config', return_value=('', [], users)), \
                patch.object(allinone, 'build_ai_clients', return_value=[]), \
                patch.object(allinone, 'run_user', side_effect=execute), \
                patch.object(allinone, 'emit_result', side_effect=lambda account, success: results.update({account: success})):
            self.assertFalse(await allinone.main(parallel=True))
        self.assertEqual(entered, {'first', 'second'})
        self.assertEqual(results, {'first': False, 'second': True})


if __name__ == '__main__':
    unittest.main()
