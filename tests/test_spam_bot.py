"""Offline official SpamBot flows: no real messages or Telegram connections."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from spam_bot import run, classify, wait_reply


class BotClient:
    def __init__(self, steps):
        self.steps = steps
        self.stage = -1
        self.sent = []
        self.clicked = []

    async def get_entity(self, name):
        assert name == 'SpamBot'
        return NS(bot=True, username='SpamBot')

    async def send_message(self, peer, text):
        self.sent.append(text)
        self.stage += 1
        return NS(id=10 + self.stage * 10, out=True)

    async def get_messages(self, peer, limit):
        assert limit == 8
        text, labels = self.steps[self.stage]
        buttons = []
        for label in labels:
            async def click(label=label):
                self.clicked.append(label)
                self.stage += 1
            buttons.append(NS(text=label, button=NS(url=None), click=click))
        return [NS(id=11 + self.stage * 10, out=False, raw_text=text, buttons=[buttons] if buttons else [])]


class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_status_queries_never_submit(self):
        for text, status in [('Good news, no limits are currently applied to your account.', 'clear'),
                             ('Your account is currently limited until 20 Oct 2026.', 'limited'),
                             ('您的账号受到限制，只能给双向联系人发消息。', 'limited'),
                             ('Your account is not limited.', 'clear'),
                             ('Please read our FAQ about accounts that can be limited.', 'unknown')]:
            client = BotClient([(text, ['This is a mistake'])])
            result = await run(client, 'spam_check')
            self.assertEqual(result['spam']['status'], status)
            self.assertEqual(client.sent, ['/start'])
            self.assertEqual(client.clicked, [])

    async def test_full_appeal_and_no_false_unrestriction(self):
        client = BotClient([
            ('Your account is currently limited.', ['This is a mistake']),
            ('Would you like to submit a complaint?', ['Yes']),
            ('Did you ever send unsolicited advertising?', ["No, I'll never do any of this!"]),
            ('Please write to us explaining why you believe the restriction is a mistake.', []),
            ('Thank you! Your complaint has been successfully submitted.', []),
        ])
        result = await run(client, 'spam_appeal', 'Please review this account restriction.', True)
        self.assertEqual(result['spam']['appealState'], 'submitted')
        self.assertTrue(result['spam']['appealSent'])
        self.assertEqual(result['spam']['status'], 'limited', 'accepted appeals do not mean restrictions have been lifted')
        self.assertEqual(client.sent, ['/start', 'Please review this account restriction.'])
        self.assertEqual(len(client.clicked), 3)

    async def test_manual_verification_and_unknown_questions(self):
        for text, buttons in [('Complete CAPTCHA verification.', ['Open website']),
                              ('Did you send advertising to strangers?', ['Yes']),
                              ('Unknown question about your password.', ['Continue'])]:
            client = BotClient([(text, buttons)])
            result = await run(client, 'spam_appeal', 'Please review the restriction on my account.', True)
            self.assertEqual(result['spam']['appealState'], 'manual')
            self.assertEqual(client.sent, ['/start'])
            self.assertEqual(client.clicked, [])
        client = BotClient([('Your account is currently limited.', ['This is a mistake'])])
        self.assertEqual((await run(client, 'spam_appeal', 'Please review this account.', False))['status'], 'action_blocked')
        self.assertEqual(client.sent, [])

    async def test_existing_pending_and_no_limit(self):
        for text, expected in [('You already submitted a complaint. Please wait.', 'pending'),
                               ("You are free as a bird!", 'not_needed')]:
            client = BotClient([(text, [])])
            result = await run(client, 'spam_appeal', 'Please review this account restriction.', True)
            self.assertEqual(result['spam']['appealState'], expected)
            self.assertEqual(client.sent, ['/start'])

    async def test_reply_polling_filters_outgoing_old_and_accepts_edits(self):
        old = NS(id=11, out=False, raw_text='old', buttons=[])
        edit = NS(id=11, out=False, raw_text='updated', buttons=[])
        class Client:
            async def get_messages(self, peer, limit):
                return [NS(id=30, out=True, raw_text='outgoing', buttons=[]), NS(id=2, out=False, raw_text='stale', buttons=[]), edit]
        from spam_bot import signature
        self.assertIs(await wait_reply(Client(), None, 11, signature(old)), edit)
        client = BotClient([])
        async def wrong_peer(name):
            return NS(bot=True, username='FakeSpamBot')
        with patch.object(client, 'get_entity', wrong_peer):
            self.assertEqual((await run(client, 'spam_check'))['status'], 'action_blocked')
            self.assertEqual(client.sent, [])


if __name__ == '__main__':
    unittest.main()
