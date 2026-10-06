import asyncio
import types
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('worker', ROOT / 'automation_worker.py')
assert spec is not None and spec.loader is not None
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class RandomTimeTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2028, 1, 1, 8, tzinfo=worker.CHINA_TIME)
        self.rule = {'id':'same_id','account':'a','repeat':'daily','timeMode':'random','rangeStart':'09:00:01','rangeEnd':'09:00:03'}

    def test_plans(self):
        plans, claimed = {}, {}
        rules = [self.rule, {**self.rule, 'account':'b'}]
        worker.plan_schedules(rules, self.now, plans, claimed, lambda a,b:a)
        self.assertEqual([p['time'] for p in plans.values()], ['09:00:01','09:00:01'])
        with tempfile.TemporaryDirectory() as directory, patch.object(worker, 'STATE_PATH', Path(directory)/'state'):
            worker.save_sent({},plans,claimed)
            stamp=worker.STATE_PATH.stat().st_mtime_ns
            worker.save_sent({},plans,claimed)
            self.assertEqual(worker.STATE_PATH.stat().st_mtime_ns,stamp)
            plans=worker.load_state()['planned']
            worker.plan_schedules(rules,self.now,plans,claimed,lambda a,b:self.fail('redraw on restart'))
            rules[0]['rangeStart']='09:00:02'
            worker.plan_schedules(rules,self.now,plans,claimed,lambda a,b:b)
            self.assertEqual(next(iter(plans.values()))['time'],'09:00:03')
            key=next(iter(plans));claimed[key]='done'
            rules[0]['rangeEnd']='09:00:05'
            worker.plan_schedules(rules,self.now,plans,claimed,lambda a,b:self.fail('claimed redraw'))
            rules[0]['enabled']=False
            worker.plan_schedules(rules,self.now,plans,claimed)
            self.assertEqual(len(plans),1)
            worker.plan_schedules([],self.now,plans,claimed)
            self.assertEqual(plans,{})
            self.rule['enabled']=True
            worker.plan_schedules([self.rule],self.now+dt.timedelta(days=1),plans,claimed,lambda a,b:a)
            self.assertEqual(next(iter(plans.values()))['date'],'2028-01-02')

    def test_endpoints_and_due(self):
        plans={}
        worker.plan_schedules([self.rule],self.now,plans,{},lambda a,b:b)
        plan=next(iter(plans.values()))
        at=self.now.replace(hour=9,second=3)
        self.assertEqual(worker.occurrence(self.rule,at,plan),'2028-01-01')
        self.assertIsNone(worker.occurrence(self.rule,at-dt.timedelta(seconds=1),plan))
        self.assertIsNone(worker.occurrence(self.rule,at+dt.timedelta(seconds=10),plan))
        for time,seconds,expected in [('09:00',59,True),('09:00:00',9,True),('09:00:00',10,False)]:
            result=worker.occurrence({'repeat':'daily','time':time},self.now.replace(hour=9,second=seconds))
            self.assertEqual(bool(result),expected)
        self.assertEqual(worker.occurrence({'repeat':'once','time':'2028-01-01T09:00:03'},at),'2028-01-01T09:00:03')
        with self.assertRaises(ValueError):
            worker.plan_schedules([{**self.rule,'rangeStart':'23:00','rangeEnd':'01:00'}],self.now,{}, {})

    def test_write_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(worker,'STATE_PATH',Path(directory)/'state'):
            worker.save_sent({})
            before=worker.STATE_PATH.read_bytes()
            with patch.object(worker.os,'replace',side_effect=OSError('offline disk error')):
                with self.assertRaises(OSError): worker.save_sent({}, {'new':'plan'})
            self.assertEqual(worker.STATE_PATH.read_bytes(),before)

class WorkerDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_random_dispatch_restart_and_commit_failure(self):
        fixed = dt.datetime(2028, 1, 1, 9, 0, 3, tzinfo=worker.CHINA_TIME)
        class Frozen(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return fixed
        sent = []
        class Client:
            def __init__(self, session, *args, **kwargs): self.session = Path(session).name
            async def connect(self): pass
            async def is_user_authorized(self): return True
            async def disconnect(self): pass
            async def get_input_entity(self, chat): return chat
            async def send_message(self, target, message): sent.append((self.session, message))
        fake = types.ModuleType('telethon')
        fake.TelegramClient = Client
        fake.events = types.SimpleNamespace()
        schedules = [{"id":"shared_id", "account":account,"target":"@test", "repeat":"daily", "timeMode":"random", "rangeStart":"09:00:03", "rangeEnd":"09:00:03", "message":"verbatim /sign with spaces"} for account in ('a','b')]
        config = {"telegram":{"users":[{"name":account,"session":account,"api_id":123,"api_hash":"offline"} for account in ('a','b')]},"automations":{"schedules":schedules,"forwards":[]}}
        async def run_briefly():
            task = asyncio.create_task(worker.main())
            await asyncio.sleep(.03)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, {'telethon':fake}), patch.object(worker.dt,'datetime',Frozen), patch.object(worker,'DATA_DIR',Path(directory)), patch.object(worker,'CONFIG_PATH',Path(directory)/'config.json'), patch.object(worker,'STATE_PATH',Path(directory)/'state.json'):
            worker.CONFIG_PATH.write_text(json.dumps(config))
            with patch.object(worker.os,'replace',side_effect=OSError('disk fail')):
                await run_briefly()
            self.assertEqual(sent,[])
            await run_briefly()
            self.assertEqual(sent,[('a','verbatim /sign with spaces'),('b','verbatim /sign with spaces')])
            saved = worker.load_state()
            self.assertEqual(len(saved['planned']),2)
            self.assertEqual(len(saved['claimed']),2)
            self.assertEqual(len(saved['sent']),2)
            await run_briefly()
            self.assertEqual(len(sent),2)
            # Preserve same-day claims if a range is edited after dispatch.
            schedules[0]['rangeEnd']='09:00:05'
            worker.CONFIG_PATH.write_text(json.dumps(config))
            await run_briefly()
            self.assertEqual(len(sent),2)

if __name__ == '__main__':
    with patch.object(socket.socket,'connect',side_effect=AssertionError('network forbidden')):
        unittest.main()
