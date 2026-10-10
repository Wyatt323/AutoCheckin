"""Offline group cleanup safety/confirmation/report tests. Never connects to Telegram."""
import asyncio
import datetime as dt
import io
import tempfile
import types
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import AsyncMock, patch
import offline_support
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import cleanup_worker as worker


class Members(list):
    total = 4


class Client:
    def __init__(self, choice='是', *, complete=True, supergroup=True):
        self.group=types.SimpleNamespace(title='测试群',megagroup=True) if supergroup else type('Chat',(),{'title':'测试群'})()
        admin=type('ChannelParticipantAdmin',(),{})()
        self.members=Members([types.SimpleNamespace(id=i,username=None if i==2 else 'user'+str(i),first_name='=SUM(A1)' if i==2 else '名字'+str(i),last_name='',participant=admin if i==4 else None) for i in (1,2,3,4)])
        if not complete:self.members.total=8
        self.choice=choice;self.messages=[];self.files=[];self.handlers=[];self.permission_calls=[]
        self.edit_permissions=AsyncMock();self.kick_participant=AsyncMock()
        self.new_speech=False;self.promoted=False;self.scan_error=False;self.send_error=False;self.can_ban=True
    async def get_entity(self,value):return self.group
    async def get_me(self):return self.members[0]
    async def get_permissions(self,group,member):
        self.permission_calls.append(member.id)
        return types.SimpleNamespace(is_creator=False,is_admin=member.id in (1,4) or self.promoted,ban_users=self.can_ban,has_left=False,is_banned=False,participant=types.SimpleNamespace(date=dt.datetime(2020,1,1,tzinfo=dt.timezone.utc)))
    async def get_participants(self,group,**kw):return self.members
    async def get_messages(self,group,**kw):return [types.SimpleNamespace(id=10)]
    async def send_message(self,group,text):
        self.messages.append(text);return types.SimpleNamespace(id=100+len(self.messages))
    async def send_file(self,group,file,**kw):
        if self.send_error:raise RuntimeError('offline report delivery failed')
        self.files.append((file,kw))
    def add_event_handler(self,handler,event):self.handlers.append(handler)
    def remove_event_handler(self,handler):self.handlers.remove(handler)
    async def iter_messages(self,group,**kw):
        if 'max_id' in kw:
            if self.scan_error:raise RuntimeError('offline history incomplete')
            yield types.SimpleNamespace(id=8,sender_id=3,action=None,date=dt.datetime(2020,1,1,tzinfo=dt.timezone.utc))
            yield types.SimpleNamespace(id=9,sender_id=2,action=object(),date=None)
        elif 'min_id' in kw:
            if self.choice:yield types.SimpleNamespace(id=200,sender_id=1,raw_text=self.choice)
        elif self.new_speech:
            yield types.SimpleNamespace(id=201,sender_id=2,action=None)


class CleanupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.report=Path(self.directory.name)/'report.xlsx'
        self.saved=[]
        self.output=patch('sys.stdout',io.StringIO());self.output.start()
        self.sleep=patch.object(worker.asyncio,'sleep',AsyncMock());self.sleep.start()
    async def asyncTearDown(self):
        self.sleep.stop();self.output.stop();self.directory.cleanup()
    async def run_cleanup(self,client,save=None,**kw):
        return await worker.clean_group(client,{'id':'offline','group':'@testgroup','account':'first'},save or (lambda state:self.saved.append(__import__('copy').deepcopy(state))),self.report,**kw)
    def test_confirmation_owns_group_prompt_and_sender(self):
        def message(**kw):return types.SimpleNamespace(id=101,sender_id=1,raw_text=' 是 ',**kw)
        self.assertEqual(worker.confirmation(message(),1,100),'是')
        for msg in [types.SimpleNamespace(id=101,sender_id=2,raw_text='是'),types.SimpleNamespace(id=99,sender_id=1,raw_text='是'),message(fwd_from=object()),message(reply_to_msg_id=9),types.SimpleNamespace(id=101,sender_id=1,raw_text='yes')]:
            self.assertIsNone(worker.confirmation(msg,1,100))
        self.assertIsNone(worker.confirmation(message(),1,None))
    async def test_yes_reports_then_kicks_and_unbans_only_eligible(self):
        client=Client();result=await self.run_cleanup(client)
        self.assertEqual(result,'completed');self.assertEqual(client.messages[0],'正在查看0发言人数')
        self.assertIn('群成员4人，检测到0发言人数3人',client.files[0][1]['caption'])
        self.assertIn('是否踢出0发言成员',client.messages[1])
        self.assertEqual(client.edit_permissions.await_count,2)
        ban,unban=client.edit_permissions.await_args_list
        self.assertEqual(ban.args[1].id,2);self.assertFalse(ban.kwargs['view_messages'])
        self.assertTrue(30 < (ban.kwargs['until_date']-dt.datetime.now(dt.timezone.utc)).total_seconds() <= 120)
        self.assertEqual(unban.kwargs,{})
        self.assertEqual(self.saved[-1]['removed'],1);self.assertEqual(self.saved[-1]['restorePending'],0)
        self.assertEqual(self.saved[-1]['candidates'][1]['username'],'')
    async def test_no_and_timeout_never_kick(self):
        for choice in ('否',None):
            client=Client(choice);result=await self.run_cleanup(client,confirmation_timeout=0.001)
            self.assertEqual(result,'cancelled');client.edit_permissions.assert_not_awaited();client.kick_participant.assert_not_awaited()
            self.assertIn('已取消本次清理任务',client.messages[-1]);self.assertEqual(client.handlers,[])
    async def test_partial_members_no_kick_or_confirmation(self):
        client=Client(complete=False);self.assertEqual(await self.run_cleanup(client),'failed')
        client.edit_permissions.assert_not_awaited();self.assertFalse(any('回答是或否' in message for message in client.messages))
        self.assertTrue(self.report.exists())
    async def test_failed_history_or_report_delivery_never_kicks(self):
        for flag in ('scan_error','send_error'):
            client=Client();setattr(client,flag,True)
            with self.assertRaises(RuntimeError):await self.run_cleanup(client)
            client.edit_permissions.assert_not_awaited();self.assertFalse(client.handlers)
    async def test_permission_gate_before_messages(self):
        client=Client();client.can_ban=False
        with self.assertRaises(ValueError):await self.run_cleanup(client)
        self.assertFalse(client.messages);client.edit_permissions.assert_not_awaited()
    async def test_new_speech_and_new_admin_are_skipped(self):
        for flag in ('new_speech','promoted'):
            client=Client()
            def save(state):
                self.saved.append(dict(state))
                if state['phase']=='kicking':setattr(client,flag,True)
            self.assertEqual(await self.run_cleanup(client,save),'completed')
            client.edit_permissions.assert_not_awaited();self.assertEqual(self.saved[-1]['skipped'],1)
    async def test_storage_failure_prevents_ban(self):
        client=Client()
        def save(state):
            if state.get('pendingRestoreId'):raise RuntimeError('offline durable write failed')
        with self.assertRaises(RuntimeError):await self.run_cleanup(client,save)
        client.edit_permissions.assert_not_awaited()
    async def test_failed_unban_is_partial_with_expiring_ban(self):
        client=Client();client.edit_permissions.side_effect=[None,RuntimeError('offline restore failure'),RuntimeError('offline restore failure'),RuntimeError('offline restore failure')]
        self.assertEqual(await self.run_cleanup(client),'partial')
        self.assertEqual(self.saved[-1]['restorePending'],1)
        self.assertIn('120秒',client.messages[-1])
    async def test_normal_group_has_no_ban(self):
        client=Client(supergroup=False);self.assertEqual(await self.run_cleanup(client),'completed')
        client.kick_participant.assert_awaited_once();client.edit_permissions.assert_not_awaited()
    async def test_cancel_during_ban_still_restores(self):
        client=Client();entered=asyncio.Event()
        async def edit(*args,**kw):
            if kw:
                entered.set();await asyncio.Future()
        client.edit_permissions.side_effect=edit
        task=asyncio.create_task(self.run_cleanup(client));await asyncio.wait_for(entered.wait(),1);task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertEqual(client.edit_permissions.await_count,2);self.assertEqual(client.edit_permissions.await_args_list[-1].kwargs,{})
    async def test_parent_pipe_eof_or_error_cancels_task(self):
        async def blocked():await asyncio.Future()
        for fail in (False,True):
            task=asyncio.create_task(blocked())
            def read():
                if fail:raise OSError('offline closed pipe')
                return b''
            worker.cancel_when_parent_closes(task,asyncio.get_running_loop(),read)
            with self.assertRaises(asyncio.CancelledError):await task
    async def test_worker_main_uses_job_account_and_disconnects(self):
        client=Client();client.connect=AsyncMock();client.disconnect=AsyncMock();client.is_user_authorized=AsyncMock(return_value=True)
        job_id='11111111-1111-4111-8111-111111111111'
        job={'id':job_id,'account':'first','group':'@testgroup'}
        config={'telegram':{'users':[{'name':'First','session':'first','api_id':123,'api_hash':'offline'}]}}
        with patch.object(worker,'DATA_DIR',Path(self.directory.name)),patch.object(worker,'read_document',side_effect=[job,config]),patch.object(worker,'write_document') as write,patch.object(sys.modules['telethon'],'TelegramClient',return_value=client) as factory:
            self.assertEqual(await worker.main(job_id),0)
        self.assertEqual(factory.call_args.args[0],str(Path(self.directory.name)/'first'))
        self.assertEqual(factory.call_args.kwargs['device_model'],'AutoCheckin')
        self.assertTrue(all(call.args[0]=='cleanup-job:'+job_id for call in write.call_args_list))
        client.disconnect.assert_awaited_once()
    def test_xlsx_ids_and_names_are_literal_text(self):
        worker.write_report(self.report,[['9223372036854775807','@test','=HYPERLINK("bad")','待确认']], [['检测范围','可访问历史']])
        with zipfile.ZipFile(self.report) as archive:
            self.assertIsNone(archive.testzip())
            for name in archive.namelist():ET.fromstring(archive.read(name))
            xml=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
            ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            self.assertFalse(xml.findall('.//s:f',ns));self.assertTrue(all(cell.attrib['t']=='inlineStr' for cell in xml.findall('.//s:c',ns)))
            self.assertIn('9223372036854775807',archive.read('xl/worksheets/sheet1.xml').decode())


if __name__=='__main__':unittest.main()
