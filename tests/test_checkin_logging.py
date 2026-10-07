import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkin_logging import ScopedOutput, account_log


class CheckinLoggingTests(unittest.IsolatedAsyncioTestCase):
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
