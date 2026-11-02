"""Read replies in a bounded window after a scheduled message is sent."""
import asyncio
import time


class ScheduledReplyReader:
    def __init__(self, client, log, *, window_seconds=300, debounce_seconds=0.25):
        from telethon import events, utils
        self.client, self.log = client, log
        self.peer_id = utils.get_peer_id
        self.window_seconds, self.debounce_seconds = window_seconds, debounce_seconds
        self.watches, self.tasks = {}, set()
        self.closed = False
        self.handler = self.on_reply
        client.add_event_handler(self.handler, events.NewMessage(incoming=True))

    def begin(self, rule, target):
        """Listen before sending so a fast reply cannot race send_message()."""
        chat = self.peer_id(target)
        watch = self.watches.get(chat)
        if watch is None:
            watch = {'chat': chat, 'target': target, 'rule': rule, 'sending': 0,
                     'expires': 0, 'pending': 0, 'read': 0, 'task': None, 'timer': None}
            self.watches[chat] = watch
        watch['sending'] += 1
        return watch

    def sent(self, watch, rule):
        watch['sending'] -= 1
        watch['rule'] = rule
        watch['expires'] = time.monotonic() + self.window_seconds
        if watch['timer']:
            watch['timer'].cancel()
        watch['timer'] = asyncio.get_running_loop().call_later(self.window_seconds, self.expire, watch)
        self.start_read(watch)

    def failed(self, watch):
        watch['sending'] -= 1
        if not watch['sending'] and watch['expires'] <= time.monotonic():
            self.discard(watch)

    def expire(self, watch):
        watch['timer'] = None
        if not watch['sending']:
            self.discard(watch)

    def discard(self, watch):
        if self.watches.get(watch['chat']) is watch:
            del self.watches[watch['chat']]
        if watch['timer']:
            watch['timer'].cancel()
        if watch['task']:
            watch['task'].cancel()

    def active(self, watch):
        return (not self.closed and self.watches.get(watch['chat']) is watch
                and watch['expires'] > time.monotonic())

    async def on_reply(self, event):
        watch = self.watches.get(event.chat_id)
        if self.closed or watch is None or event.message.out:
            return
        if not self.active(watch) and not watch['sending']:
            self.discard(watch)
            return
        watch['pending'] = max(watch['pending'], event.message.id)
        self.start_read(watch)

    def start_read(self, watch):
        # No RPCs in the event handler; listeners on the same client keep running.
        if self.active(watch) and watch['pending'] > watch['read'] and watch['task'] is None:
            task = asyncio.create_task(self.read(watch))
            watch['task'] = task
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

    async def read(self, watch):
        warned = False
        try:
            await asyncio.sleep(self.debounce_seconds)
            while self.active(watch) and watch['pending'] > watch['read']:
                message_id = watch['pending']
                try:
                    # Acknowledge only received replies, never messages arriving later.
                    await asyncio.wait_for(self.client.send_read_acknowledge(
                        watch['target'], max_id=message_id), timeout=10)
                except Exception as error:
                    if not warned:
                        self.log(watch['rule'], 'message',
                                 f"定时消息的回复自动已读失败，将在本轮等待窗口内重试：{error}",
                                 'warning', state='completed')
                        warned = True
                    delay = getattr(error, 'seconds', None)
                    delay = delay + 1 if isinstance(delay, (int, float)) and delay > 0 else 30
                    await asyncio.sleep(min(delay, max(0, watch['expires'] - time.monotonic())))
                else:
                    watch['read'] = message_id
                    self.log(watch['rule'], 'message',
                             f"已将 {watch['rule']['target']} 的定时消息回复标记为已读")
                    if watch['pending'] > watch['read']:
                        await asyncio.sleep(self.debounce_seconds)
        finally:
            watch['task'] = None

    async def close(self):
        self.closed = True
        self.client.remove_event_handler(self.handler)
        for watch in list(self.watches.values()):
            self.discard(watch)
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
