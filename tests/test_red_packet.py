"""Offline event, callback, refresh, isolation and persistence regression tests."""
import asyncio
import datetime as dt
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import offline_support
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import red_packet as red
import automation_worker as worker

CHAT = -100123


def rule(**values):
    return {'id': 'red_rule_001', 'name': '测试红包', 'account': 'first', 'groups': ['@group'],
            'watchSeconds': 120, 'retryInterval': 0.5, **values}


def message(id=11, text='', button=False, bot=True, username='niubi_bot', reply=None, answer='领取成功'):
    result = types.SimpleNamespace(id=id, raw_text=text, chat_id=CHAT, reply_to_msg_id=reply,
        sender_id=1 if bot else 2, sender=types.SimpleNamespace(bot=bot, username=username),
        buttons=[[types.SimpleNamespace(text='👆 好運連連', data=b'claim')]] if button else [],
        click=AsyncMock(return_value=types.SimpleNamespace(message=answer)))
    return result


async def settle():
    for _ in range(8):
        await asyncio.sleep(0)


class RedPacketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.logs, self.monitors = [], []

    async def asyncTearDown(self):
        for monitor in self.monitors:
            await monitor.close()

    def monitor(self, rules=None, account='first', completed=None, **kwargs):
        client = types.SimpleNamespace(get_messages=AsyncMock(return_value=[]))
        monitor = red.RedPacketMonitor(client,account,{CHAT:{'peer':'@group','rules':rules or [rule()]}},
            lambda text, level='info', **metadata: self.logs.append({'text':text,'level':level,**metadata}),completed,**kwargs)
        # Event tests need no polling. The refresh test removes this sentinel.
        monitor.refreshers[CHAT] = None
        self.monitors.append(monitor)
        return monitor

    async def deliver(self, monitor, msg, edited=False):
        await monitor.handle(types.SimpleNamespace(chat_id=CHAT,message=msg),edited=edited)

    async def begin(self, monitor, id=10):
        await self.deliver(monitor,message(id,'/red 66 10',bot=False))

    async def test_idle_and_command_prefix_and_edited_command(self):
        monitor=self.monitor()
        for text in ['/sign','/checkin','hello /red','red66']:
            await self.deliver(monitor,message(10,text,bot=False))
        await self.deliver(monitor,message(10,'/red 66 10',bot=False),edited=True)
        self.assertFalse(monitor.windows)
        monitor.client.get_messages.assert_not_awaited()
        await self.deliver(monitor,message(10,'/red@niubi_bot 66 10',bot=False))
        self.assertEqual(len(monitor.windows),1)

    async def test_fresh_packet_without_red_command_is_claimed(self):
        monitor=self.monitor()
        packet=message(11,'🧧 牛币红包',button=True)
        await self.deliver(monitor,packet)
        await settle()
        packet.click.assert_awaited_once()
        self.assertEqual(monitor.completed[monitor.packet_key(CHAT,11)]['result'],'success')
        self.assertTrue(any('直接检测到 Bot 红包' in log['text'] for log in self.logs))

    async def test_bot_preparation_without_command_tracks_reply_and_edit(self):
        monitor=self.monitor()
        await self.deliver(monitor,message(11,'正在准备红包，稍等',reply=10))
        packet=message(12,button=True,reply=11)
        await self.deliver(monitor,packet)
        await settle()
        packet.click.assert_awaited_once()

    async def test_clock_skew_does_not_drop_recent_red_and_prefix_is_supported(self):
        monitor=self.monitor()
        command=message(10,'/red66 10',bot=False)
        command.date=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=3)
        await self.deliver(monitor,command)
        self.assertEqual(monitor.health[CHAT]['commands'],1)
        self.assertIn((CHAT,10),monitor.windows)

    async def test_bot_mismatch_is_logged_once_and_secondary_username_matches(self):
        monitor=self.monitor([rule(botUsername='@wanted_bot')])
        packet=message(button=True,username='niubi2233_bot')
        await self.deliver(monitor,packet)
        await self.deliver(monitor,packet,edited=True)
        self.assertEqual(sum('Bot 不匹配' in log['text'] for log in self.logs),1)
        packet.click.assert_not_awaited()
        monitor.senders.clear()
        packet.sender.usernames=[types.SimpleNamespace(username='wanted_bot',active=True)]
        await self.deliver(monitor,packet,edited=True)
        await settle()
        packet.click.assert_awaited_once()

    async def test_watchdog_history_watermark_and_recovery_without_events(self):
        monitor=self.monitor()
        old=message(11,button=True)
        new=message(12,button=True)
        monitor.client.get_messages.side_effect=[[old],[new]]
        await monitor.start()
        self.assertEqual(monitor.cursors[CHAT],11)
        old.click.assert_not_awaited()
        # Advance just this watchdog's wait; no network or five-second test delay.
        original_sleep=asyncio.sleep
        async def sleep(delay):
            await original_sleep(0)
        with patch.object(red.asyncio,'sleep',side_effect=sleep):
            for _ in range(15):await original_sleep(0)
            await monitor.close()
        new.click.assert_awaited_once()
        old.click.assert_not_awaited()
        self.assertTrue(any(call.kwargs.get('min_id')==11 for call in monitor.client.get_messages.call_args_list))

    async def test_preparation_edit_claims_and_duplicate_events_dedupe(self):
        persist=AsyncMock()
        monitor=self.monitor([rule(),rule(id='overlap_001')],persist=persist)
        await self.begin(monitor)
        prepare=message(11,'正在准备红包，稍等',reply=10)
        await self.deliver(monitor,prepare)
        packet=message(11,'红包',button=True,reply=10)
        await self.deliver(monitor,packet,edited=True)
        await self.deliver(monitor,packet,edited=True)
        await settle()
        packet.click.assert_awaited_once_with(i=0,j=0)
        self.assertTrue(monitor.windows[(CHAT,10)]['done'])
        self.assertEqual(monitor.completed[f'first:{CHAT}:11']['result'],'success')
        persist.assert_awaited_once()

    async def test_nonbot_wrongbot_old_message_and_url_buttons_ignored(self):
        monitor=self.monitor([rule(botUsername='@niubi_bot')])
        await self.begin(monitor)
        ignored=[message(9,button=True),message(11,button=True,bot=False),
                 message(12,button=True,username='other_bot')]
        for packet in ignored:
            await self.deliver(monitor,packet)
        url=message(14,text='红包',button=True)
        url.buttons=[[types.SimpleNamespace(text='领取红包',url='https://example.invalid')]]
        await self.deliver(monitor,url)
        await settle()
        for packet in ignored:
            packet.click.assert_not_awaited()
        url.click.assert_not_awaited()

    async def test_missing_command_reply_does_not_consume_another_window(self):
        monitor=self.monitor()
        await self.begin(monitor,id=10)
        packet=message(31,'红包',button=True,reply=30)
        await self.deliver(monitor,packet)
        await settle()
        packet.click.assert_awaited_once()
        self.assertFalse(monitor.windows[(CHAT,10)]['done'])
        self.assertTrue(monitor.windows[(CHAT,'packet:31')]['done'])

    async def test_other_member_success_does_not_end_our_window(self):
        monitor=self.monitor()
        await self.begin(monitor)
        await self.deliver(monitor,message(11,'其他人领取成功，红包剩余 5 个'))
        self.assertFalse(monitor.windows[(CHAT,10)]['done'])
        await self.deliver(monitor,message(12,'红包已领完'))
        self.assertTrue(monitor.windows[(CHAT,10)]['done'])
        self.assertIn('exhausted',[entry['result'] for entry in monitor.completed.values()])

    async def test_niubi_exhausted_caption_edit_stops_claim_and_accepts_next_packet(self):
        caption='🧧 牛币红包\n红包有价，对你的爱无价\n😎 𝓦𝔂𝓪𝓽𝓽的红包已经被抢光啦~\n🏆 手气最佳 桃子获得了 1 牛币\n𝓦𝔂𝓪𝓽𝓽获得了 1 牛币'
        self.assertEqual(red.outcome(caption,rule()),'exhausted')
        self.assertEqual(red.outcome('紅包已經被搶光啦～',rule()),'exhausted')
        monitor=self.monitor()
        await self.begin(monitor)
        packet=message(button=True,reply=10,answer='正在领取')
        await self.deliver(monitor,packet)
        await settle()
        await self.deliver(monitor,message(11,caption,reply=10),edited=True)
        self.assertTrue(monitor.windows[(CHAT,10)]['done'])
        self.assertEqual(monitor.completed[f'first:{CHAT}:11']['result'],'exhausted')
        await asyncio.sleep(0.6)
        packet.click.assert_awaited_once()
        await self.begin(monitor,id=20)
        next_packet=message(21,button=True,reply=20)
        await self.deliver(monitor,next_packet)
        await settle()
        next_packet.click.assert_awaited_once()

    async def test_button_disappearance_without_terminal_text_keeps_waiting(self):
        monitor=self.monitor()
        await self.begin(monitor)
        packet=message(button=True,answer='正在领取')
        await self.deliver(monitor,packet)
        await settle()
        await self.deliver(monitor,message(11,'🧧 牛币红包'),edited=True)
        self.assertFalse(monitor.windows[(CHAT,10)]['done'])
        self.assertNotIn(monitor.packet_key(CHAT,11),monitor.completed)

    async def test_known_packet_edit_stays_with_original_command(self):
        monitor=self.monitor()
        await self.begin(monitor,id=10)
        await self.deliver(monitor,message(30,'正在准备红包，稍等'))
        await self.begin(monitor,id=20)
        await self.deliver(monitor,message(30,'红包已经被抢光啦~'),edited=True)
        self.assertTrue(monitor.windows[(CHAT,10)]['done'])
        self.assertFalse(monitor.windows[(CHAT,20)]['done'])

    async def test_refresh_niubi_exhausted_caption_stops_polling(self):
        monitor=self.monitor()
        monitor.refreshers.clear()
        await self.begin(monitor)
        monitor.client.get_messages.return_value=[message(11,'𝓦𝔂𝓪𝓽𝓽的红包已经被抢光啦~',reply=10)]
        await asyncio.sleep(1.1)
        self.assertEqual(monitor.completed[monitor.packet_key(CHAT,11)]['result'],'exhausted')
        await asyncio.sleep(1.05)
        self.assertNotIn(CHAT,monitor.refreshers)
        count=monitor.client.get_messages.await_count
        await asyncio.sleep(0.1)
        self.assertEqual(monitor.client.get_messages.await_count,count)

    async def test_callback_already_claimed_and_custom_outcomes(self):
        self.assertEqual(red.outcome('你已经领取过这个红包',rule()),'success')
        self.assertEqual(red.outcome('领取成功，红包已领完',rule()),'exhausted')
        self.assertIsNone(red.outcome('正在领取',rule()))
        self.assertEqual(red.outcome('已抢到 6 枚币',rule(successKeywords=['已抢到'])),'success')
        monitor=self.monitor([rule(buttonKeywords=['抢一份'],successKeywords=['入账完成'])])
        await self.begin(monitor)
        packet=message(button=True,answer='入账完成')
        packet.buttons[0][0].text='抢一份'
        await self.deliver(monitor,packet)
        await settle()
        self.assertEqual(monitor.completed[f'first:{CHAT}:11']['result'],'success')

    async def test_unknown_answer_retries_and_success_stops(self):
        monitor=self.monitor()
        await self.begin(monitor)
        packet=message(button=True)
        packet.click.side_effect=[types.SimpleNamespace(message='正在领取'),types.SimpleNamespace(message='领取成功')]
        await self.deliver(monitor,packet)
        await asyncio.sleep(0.6)
        self.assertEqual(packet.click.await_count,2)
        self.assertTrue(monitor.windows[(CHAT,10)]['done'])
        await asyncio.sleep(0.55)
        self.assertEqual(packet.click.await_count,2)

    async def test_account_isolation_and_terminal_restart_dedupe(self):
        completed={}
        first=self.monitor(completed=completed)
        second=self.monitor(account='second',completed=completed)
        for monitor in (first,second):
            await self.begin(monitor)
            packet=message(button=True)
            await self.deliver(monitor,packet)
            await settle()
            packet.click.assert_awaited_once()
        self.assertEqual(len(completed),2)
        restarted=self.monitor(completed=completed)
        await self.begin(restarted)
        duplicate=message(button=True)
        await self.deliver(restarted,duplicate)
        await settle()
        duplicate.click.assert_not_awaited()

    async def test_slow_persistence_does_not_delay_another_packet(self):
        release=asyncio.Event()
        async def persist():await release.wait()
        monitor=self.monitor(persist=persist)
        try:
            await self.begin(monitor)
            first=message(button=True)
            await self.deliver(monitor,first)
            await settle()
            self.assertTrue(monitor.persistence_tasks)
            await self.begin(monitor,id=20)
            second=message(21,button=True)
            await self.deliver(monitor,second)
            await settle()
            second.click.assert_awaited_once()
        finally:
            release.set()

    async def test_own_callback_success_wins_over_concurrent_exhausted_edit(self):
        monitor=self.monitor()
        await self.begin(monitor)
        release=asyncio.Event()
        async def click(**kwargs):
            await release.wait()
            return types.SimpleNamespace(message='领取成功')
        packet=message(button=True)
        packet.click.side_effect=click
        await self.deliver(monitor,packet)
        await settle()
        await self.deliver(monitor,message(12,'红包已领完',reply=11))
        self.assertEqual(monitor.completed[f'first:{CHAT}:11']['result'],'exhausted')
        release.set()
        await settle()
        self.assertEqual(monitor.completed[f'first:{CHAT}:11']['result'],'success')

    async def test_callback_flood_wait_shared_by_account(self):
        now=[0]
        class FloodWait(Exception): seconds=2
        monitor=self.monitor(clock=lambda:now[0])
        await self.begin(monitor)
        packet=message(button=True)
        clicked=[]
        async def click(**kwargs):
            clicked.append(now[0])
            if len(clicked)==1:raise FloodWait()
            return types.SimpleNamespace(message='领取成功')
        packet.click.side_effect=click
        original_sleep=asyncio.sleep
        async def sleep(delay):
            now[0]+=delay
            await original_sleep(0)
        with patch.object(red.asyncio,'sleep',side_effect=sleep):
            await self.deliver(monitor,packet)
            for _ in range(12):await original_sleep(0)
        self.assertEqual(clicked,[0,3])
        self.assertTrue(any('限流' in log['text'] for log in self.logs))

    async def test_refresh_tracked_preparation_edit_outside_recent_messages(self):
        monitor=self.monitor()
        monitor.refreshers.clear()
        await self.begin(monitor)
        await self.deliver(monitor,message(11,'正在准备红包，稍等',reply=10))
        packet=message(11,'红包',button=True,reply=10)
        async def fetch(peer,**kwargs):
            return [packet] if 'ids' in kwargs else []
        monitor.client.get_messages.side_effect=fetch
        await asyncio.sleep(1.15)
        packet.click.assert_awaited_once()
        self.assertTrue(any(call.kwargs.get('ids')==[11] for call in monitor.client.get_messages.call_args_list))
        await asyncio.sleep(1)
        count=monitor.client.get_messages.await_count
        await asyncio.sleep(0.1)
        self.assertEqual(count,monitor.client.get_messages.await_count)
        self.assertFalse(monitor.windows)

    async def test_expired_instruction_and_close_cancel(self):
        monitor=self.monitor()
        old=message(10,'/red 1 1',bot=False)
        old.date=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=200)
        await self.deliver(monitor,old)
        self.assertFalse(monitor.windows)
        await self.begin(monitor)
        packet=message(button=True,answer='正在领取')
        await self.deliver(monitor,packet)
        await settle()
        await monitor.close()
        self.assertFalse(monitor.tasks)
        attempts=packet.click.await_count
        await self.deliver(monitor,packet,edited=True)
        self.assertEqual(attempts,packet.click.await_count)

    async def test_window_timeout_and_refresh_floodwait(self):
        now=[0]
        monitor=self.monitor(clock=lambda:now[0])
        monitor.refreshers.clear()
        await self.begin(monitor)
        monitor.flood_until=200
        await asyncio.sleep(1.05)
        monitor.client.get_messages.assert_not_awaited()
        now[0]=121
        await asyncio.sleep(1.05)
        self.assertFalse(monitor.windows)
        self.assertTrue(any('超时' in log['text'] for log in self.logs))

    def test_state_retention_and_bounds(self):
        now=__import__('time').time()
        entries={str(i):{'time':now+i/10000,'result':'success'} for i in range(2001)}
        entries['old']={'time':now-8*86400,'result':'success'}
        entries['invalid']={'time':'broken'}
        self.assertEqual(len(worker.packet_state(entries)),2000)
        self.assertNotIn('old',worker.packet_state(entries))

    async def test_worker_reuses_clients_canonical_groups_and_persists(self):
        clients, logs = {}, []
        ready=asyncio.Event()
        class Chat:
            id=123
        class Channel:
            megagroup=False
        class Client:
            def __init__(self,session,*args,**kwargs):
                self.account=Path(session).name;self.handlers=[];self.disconnected=False;self.options=kwargs;clients[self.account]=self
            async def connect(self):pass
            async def is_user_authorized(self):return True
            async def get_entity(self,value):
                if isinstance(value,int):raise ValueError('not in session cache')
                if value=='@not_joined':
                    entity=Chat();entity.left=True;return entity
                return Channel() if value=='@channel' else Chat()
            async def get_dialogs(self,**kwargs):return [types.SimpleNamespace(entity=Chat())]
            async def get_input_entity(self,value):return CHAT
            async def get_messages(self,*args,**kwargs):return []
            def add_event_handler(self,handler,event):self.handlers.append((handler,event))
            async def disconnect(self):self.disconnected=True
        def emit(text,level='info',kind='log',**metadata):
            logs.append({'text':text,**metadata})
            if kind=='ready':ready.set()
        config={'telegram':{'users':[{'name':a,'session':a,'api_id':123,'api_hash':'offline'} for a in ('first','second')]},
                'automations':{'redPackets':[rule(groups=['@group',str(CHAT),'@channel','@not_joined']),rule(account='second',id='second_001')]}}
        telethon=sys.modules['telethon']
        events=types.SimpleNamespace(NewMessage=lambda **kw:('new',kw),MessageEdited=lambda **kw:('edit',kw))
        with patch.object(telethon,'TelegramClient',Client),patch.object(telethon,'events',events), \
             patch.object(telethon,'types',types.SimpleNamespace(Chat=Chat,Channel=Channel),create=True), \
             patch.object(telethon,'utils',types.SimpleNamespace(get_peer_id=lambda peer:CHAT),create=True), \
             patch.object(worker,'load_config',return_value=config),patch.object(worker,'emit',side_effect=emit), \
             patch.object(worker,'read_document',return_value={}),patch.object(worker,'write_document') as write, \
             patch.object(worker,'load_state',return_value={'sent':{},'planned':{},'claimed':{}}),patch.object(worker,'save_sent'):
            task=asyncio.create_task(worker.main())
            try:
                await asyncio.wait_for(ready.wait(),1)
                self.assertEqual(set(clients),{'first','second'})
                for client in clients.values():
                    self.assertEqual(client.options['flood_sleep_threshold'],0)
                    self.assertEqual(len(client.handlers),2)
                    self.assertEqual(client.handlers[0][1],('new',{'chats':[CHAT]}))
                    await client.handlers[0][0](types.SimpleNamespace(chat_id=CHAT,message=message(10,'/red 1 1',bot=False)))
                    packet=message(button=True)
                    await client.handlers[1][0](types.SimpleNamespace(chat_id=CHAT,message=packet))
                await settle()
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):await task
            saved=write.call_args.args
            self.assertEqual(saved[0],'red-packet-state')
            self.assertEqual(set(saved[1]),{f'{a}:{CHAT}:11' for a in clients})
            self.assertTrue(all(client.disconnected for client in clients.values()))
            self.assertTrue(any('广播频道' in log['text'] for log in logs))
            self.assertTrue(any('账号未加入' in log['text'] for log in logs))
            self.assertEqual({log['account'] for log in logs if '领取成功' in log['text']},{'first','second'})


if __name__=='__main__':
    unittest.main()
