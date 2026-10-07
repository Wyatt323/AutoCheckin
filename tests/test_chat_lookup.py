import asyncio
import datetime
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chat_lookup
from telethon import types
from network_guard import install_network_guard
install_network_guard()


class Client:
    def __init__(self, session, *, authorized=True):
        self.session=session
        self.authorized=authorized
        self.disconnected=False
        self.references=[]
        self.dialog_reads=0
    async def connect(self): pass
    async def disconnect(self): self.disconnected=True
    async def is_user_authorized(self): return self.authorized
    async def get_entity(self, reference):
        self.references.append(reference)
        if reference=='@user_person': return types.User(id=123,first_name='Person')
        if reference=='@denied_group': raise ValueError('offline permission error with secret')
        if isinstance(reference,int): raise ValueError('not cached')
        if isinstance(reference,types.InputPeerChannel):
            return types.Channel(id=reference.channel_id,title='测试频道',photo=types.ChatPhotoEmpty(),date=datetime.datetime.now(),broadcast=True)
        return types.Chat(id=987,title='测试群组',photo=types.ChatPhotoEmpty(),participants_count=1,date=datetime.datetime.now(),version=1)
    async def get_dialogs(self, limit):
        self.dialog_reads+=1
        return [SimpleNamespace(entity=types.Chat(id=987,title='未缓存群组',photo=types.ChatPhotoEmpty(),participants_count=1,date=datetime.datetime.now(),version=1))]


class LookupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        (self.root/'config.json').write_text(json.dumps({'telegram':{'users':[{'session':'offline','api_id':123,'api_hash':'offline-secret'}]}}))
        self.file=self.root/'offline.session'
        with closing(sqlite3.connect(self.file)) as db:
            db.execute('CREATE TABLE sessions(dc_id INTEGER, server_address TEXT, port INTEGER, auth_key BLOB)')
            db.execute('INSERT INTO sessions VALUES(2,?,?,?)',('offline',443,b'x'*256))
            db.execute('CREATE TABLE entities(id INTEGER PRIMARY KEY, hash INTEGER)')
            db.execute('INSERT INTO entities VALUES(?,?)',(-1000000000123,321))
            db.commit()
    def tearDown(self): self.temp.cleanup()
    async def lookup(self, peers, authorized=True):
        before=self.file.read_bytes()
        client=None
        def factory(session,*args,**kwargs):
            nonlocal client
            self.assertFalse(kwargs['receive_updates'])
            self.assertEqual(args,(123,'offline-secret'))
            client=Client(session,authorized=authorized)
            return client
        try: return await chat_lookup.resolve_chats('offline',peers,self.root,client_factory=factory),client
        finally:
            self.assertEqual(self.file.read_bytes(),before,'metadata lookup must never modify the Session')
            if client:self.assertTrue(client.disconnected)
    async def test_cached_id_and_username(self):
        results,client=await self.lookup(['-1000000000123','@group_name'])
        self.assertEqual([r['title'] for r in results],['测试频道','测试群组'])
        self.assertEqual([r['type'] for r in results],['channel','group'])
        self.assertEqual(results[0]['id'],'-1000000000123')
        self.assertIsInstance(client.references[0],types.InputPeerChannel)
        self.assertEqual(client.dialog_reads,0)
    async def test_uncached_numeric_and_safe_errors(self):
        results,client=await self.lookup(['-987','https://t.me/group_name/','@denied_group','@user_person'])
        self.assertEqual(results[0]['title'],'未缓存群组')
        self.assertEqual(client.dialog_reads,1)
        self.assertEqual(results[2]['status'],'error')
        self.assertNotIn('secret',json.dumps(results))
        self.assertEqual(results[3]['message'],'此会话不是群组或频道')
    async def test_unauthorized_never_logs_in(self):
        with self.assertRaises(ValueError): await self.lookup(['@group_name'],authorized=False)
    def test_reference_validation(self):
        self.assertEqual(chat_lookup.normalize_peer('group_name'),'@group_name')
        self.assertEqual(chat_lookup.normalize_peer(' -123 '),-123)
        for value in ['https://evil.example/a','https://t.me/+private','../test','','a'*121]:
            with self.assertRaises(ValueError):chat_lookup.normalize_peer(value)


if __name__=='__main__': unittest.main()
