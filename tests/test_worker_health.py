"""SDK request types are real; all clients and clocks are offline."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from network_guard import install_network_guard
install_network_guard()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from telethon import functions
import telethon
import health_worker
import worker_health


class Client:
    def __init__(self, *args, **kwargs):
        self.options=kwargs
        self.connected=True
        self.authorized=True
        self.calls=[]
        self.error=None
        self.disconnected=False
    def is_connected(self):
        return self.connected
    async def connect(self):
        if self.error:
            raise self.error
    async def is_user_authorized(self):
        return self.authorized
    async def __call__(self, request, **kwargs):
        self.calls.append(request)
        if self.error:
            raise self.error
    async def disconnect(self):
        self.disconnected=True


class WorkerHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_heartbeat_and_verified_recovery(self):
        client=Client()
        rows=[]
        def emit(message, **event):
            rows.append(event)
            client.connected=len(rows)!=1
        async def sleep(_):
            if len(rows)>=3:
                raise asyncio.CancelledError()
        with patch.object(worker_health.asyncio,'sleep',side_effect=sleep):
            with self.assertRaises(asyncio.CancelledError):
                await worker_health.heartbeat(client,'first','automation',emit,probe_interval=0)
        self.assertEqual([row['status'] for row in rows],['online','offline','online'])
        self.assertTrue(all(isinstance(request,functions.updates.GetStateRequest) for request in client.calls))
        self.assertEqual(len(client.calls),2)
        self.assertTrue(all(row['account']=='first' and row['source']=='automation' for row in rows))

    async def test_auth_expiry_and_flood_wait_are_distinct(self):
        for error,status in [(type('SessionRevokedError',(Exception,),{})(),'login_required'),
                             (type('FloodWaitError',(Exception,),{'seconds':60})(),'rate_limited')]:
            client=Client();client.error=error;rows=[]
            async def sleep(_):
                raise asyncio.CancelledError()
            with patch.object(worker_health.asyncio,'sleep',side_effect=sleep):
                with self.assertRaises(asyncio.CancelledError):
                    await worker_health.heartbeat(client,'first','checkin',lambda message,**event:rows.append(event),probe_interval=0)
            self.assertEqual(rows[0]['status'],status)

    async def test_idle_probe_auth_connection_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,'first.session').write_text('offline')
            config={'telegram':{'users':[{'session':'first'}]}}
            for authorized,error,expected in [(True,None,'online'),(False,None,'login_required'),
                                              (True,ConnectionError('never-log-secret'),'offline')]:
                client=Client();client.authorized=authorized;client.error=error
                with patch.dict(os.environ,{'AUTOCHECKIN_DATA_DIR':directory}), \
                     patch.object(health_worker,'read_document',return_value=config), \
                     patch.object(health_worker,'resolve_credentials',return_value=(123,'secret')), \
                     patch.object(health_worker,'telegram_proxy_kwargs',return_value={}), \
                     patch.object(telethon,'TelegramClient',return_value=client):
                    status,detail=await health_worker.check('first')
                self.assertEqual(status,expected)
                self.assertNotIn('secret',detail)
                self.assertTrue(client.disconnected)
            with patch.dict(os.environ,{'AUTOCHECKIN_DATA_DIR':directory}),patch.object(health_worker,'read_document',return_value=config),patch.object(telethon,'TelegramClient') as factory:
                self.assertEqual((await health_worker.check('missing'))[0],'login_required')
                factory.assert_not_called()


if __name__=='__main__':
    unittest.main()
