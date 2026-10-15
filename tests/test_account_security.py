"""Real Telethon request types and offline RPCs; no real messages or session revocations."""
import asyncio
import datetime as dt
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from telethon import functions, errors
from account_security import operate, error_result


def device(hash, current=False):
    return NS(hash=hash, current=current, device_model='Offline phone', platform='Android',
              system_version='14', app_name='Telegram', app_version='1', ip='192.0.2.1',
              country='Example', region='Test', date_created=dt.datetime.now(dt.timezone.utc),
              date_active=dt.datetime.now(dt.timezone.utc), unconfirmed=False, password_pending=False)


class Client:
    def __init__(self):
        self.calls = []
        self.devices = [device(0, True), device(9123456789012345678)]
        self.failure = None
        self.after_reset = None
        self.restricted = False

    async def __call__(self, request, **kwargs):
        self.calls.append(request)
        assert kwargs == {'flood_sleep_threshold': 0}
        if self.failure:
            raise self.failure
        if isinstance(request, functions.users.GetUsersRequest):
            return [NS(id=123, restricted=self.restricted, scam=False, fake=False, restriction_reason=[])]
        if isinstance(request, functions.account.GetPasswordRequest):
            return NS(has_password=True, has_recovery=False, secret_salt='never_return_this')
        if isinstance(request, functions.account.GetAuthorizationsRequest):
            return NS(authorizations=self.devices)
        if isinstance(request, functions.account.ResetAuthorizationRequest):
            self.devices = [row for row in self.devices if row.hash != request.hash]
            self.failure = self.after_reset
            return True
        raise AssertionError('Unexpected or message-sending RPC')


class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_read_only_and_sanitized(self):
        client = Client()
        result = await operate(client)
        self.assertEqual(result['status'], 'reachable')
        self.assertTrue(result['twoFactor'])
        self.assertEqual(result['devices'][1]['hash'], '9123456789012345678')
        self.assertNotIn('never_return_this', str(result))
        self.assertEqual(len(client.calls), 3)
        client.restricted = True
        self.assertEqual((await operate(client))['status'], 'restricted')

    async def test_revoke_protects_current_and_stale_device(self):
        client = Client()
        for hash in ['0', 'not_found']:
            self.assertEqual((await operate(client, 'terminate', hash))['status'], 'action_blocked')
        self.assertFalse(any(isinstance(r, functions.account.ResetAuthorizationRequest) for r in client.calls))
        result = await operate(client, 'terminate', '9123456789012345678')
        self.assertTrue(result['terminated'])
        self.assertEqual(len(result['devices']), 1)
        self.assertEqual(next(r.hash for r in client.calls if isinstance(r, functions.account.ResetAuthorizationRequest)), 9123456789012345678)

    async def test_errors_and_post_revoke_failure(self):
        for error, status in [(errors.FloodWaitError(None, 90), 'rate_limited'),
                              (errors.UserDeactivatedBanError(None), 'banned'),
                              (errors.AuthKeyDuplicatedError(None), 'login_required'),
                              (errors.FreshResetAuthorisationForbiddenError(None), 'action_blocked'),
                              (errors.FrozenMethodInvalidError(None), 'restricted'),
                              (ConnectionError('private API secret'), 'unavailable')]:
            client = Client()
            client.failure = error
            result = await operate(client)
            self.assertEqual(result['status'], status)
            self.assertNotIn('private API secret', str(result))
        self.assertEqual(error_result(errors.FloodWaitError(None, 90))['waitSeconds'], 90)
        client = Client()
        client.after_reset = ConnectionError('lost connection after successful revoke')
        result = await operate(client, 'terminate', '9123456789012345678')
        self.assertTrue(result['terminated'], 'successful revoke must not look like an unexecuted operation')
        self.assertEqual(result['status'], 'unavailable')

    async def test_shared_connection_control(self):
        import automation_worker
        client = Client()
        control = automation_worker.CheckinControl({'owner': client})
        events = []
        with patch.object(automation_worker, 'write_raw', events.append):
            control.dispatch({'type': 'account_security', 'id': 'security_request_1', 'account': 'owner', 'action': 'inspect'})
            await asyncio.gather(*control.security_jobs.values())
            self.assertEqual(events[0]['account'], 'owner')
            self.assertEqual(events[0]['result']['status'], 'reachable')
            self.assertEqual(len(client.calls), 3, 'inspection uses the existing client')
            control.dispatch({'type': 'account_security', 'id': 'security_request_2', 'account': 'foreign', 'action': 'inspect'})
            self.assertEqual(len(events), 1)
        await control.close()


if __name__ == '__main__':
    unittest.main()
