import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkin_logging import ScopedOutput, account_log, emit_bot_result, result_status


class CheckinLoggingTests(unittest.IsolatedAsyncioTestCase):
    async def test_bot_results_preserve_remark_and_final_status(self):
        sink = io.StringIO()
        with patch('checkin_logging._sink', sink):
            emit_bot_result('alpha', '@niubi_bot', 'niubi_bot', '牛逼', '🎉 签到成功')
            emit_bot_result('alpha', '@slow_bot', 'slow_bot', '', '⏰ 超时')
        rows = [json.loads(line) for line in sink.getvalue().splitlines()]
        self.assertEqual(rows[0], {'type': 'bot_result', 'account': 'alpha', 'bot': '@niubi_bot',
                                  'name': 'niubi_bot', 'note': '牛逼', 'status': 'success', 'result': '🎉 签到成功'})
        self.assertEqual(rows[1]['status'], 'timeout')
        for text, status in [('今日已签到', 'already'), ('打卡成功', 'success'), ('无签到方式', 'skipped'),
                             ('签到失败', 'failed'), ('未知', 'unknown')]:
            self.assertEqual(result_status(text), status)
        with patch('checkin_logging._sink', None), patch('sys.stdout', sink):
            emit_bot_result('alpha', '@niubi_bot', 'niubi_bot', '牛逼', '🎉 签到成功')
        self.assertIn('✅ 牛逼（niubi_bot）', sink.getvalue())

    async def test_interleaved_tasks_preserve_account_and_stream(self):
        sink = io.StringIO()
        stdout, stderr = ScopedOutput(sink, 'stdout'), ScopedOutput(sink, 'stderr')

        async def job(account):
            with account_log(account):
                stdout.write(account + ':')
                await asyncio.sleep(0)
                stdout.write('done\n')
                stderr.write(account + ':error')

        with patch.object(sys, 'stdout', stdout), patch.object(sys, 'stderr', stderr):
            await asyncio.gather(job('alpha'), job('beta'))
            print('batch summary')
        rows = [json.loads(line) for line in sink.getvalue().splitlines()]
        self.assertEqual(len(rows), 5)
        for row in rows[:4]:
            self.assertTrue(row['text'].startswith(row['account'] + ':'))
        self.assertIsNone(rows[-1]['account'])
        self.assertEqual(sum(row['stream'] == 'stderr' for row in rows), 2)

    async def test_long_lines_are_bounded(self):
        sink = io.StringIO()
        output = ScopedOutput(sink, 'stdout')
        with account_log('alpha'):
            output.write('x' * 10001 + '\n')
        rows = [json.loads(line) for line in sink.getvalue().splitlines()]
        self.assertEqual(sum(len(row['text']) for row in rows), 10001)
        self.assertTrue(all(len(row['text']) <= 2000 and row['account'] == 'alpha' for row in rows))


if __name__ == '__main__':
    unittest.main()
