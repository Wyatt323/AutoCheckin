"""Event-driven red packet claims with short, bounded refresh windows."""
import asyncio
import re
import time

BUTTON_WORDS = ['好运连连', '好運連連', '领取红包', '領取紅包', '抢红包', '搶紅包', '领取', '領取', '拆红包', '拆紅包']
SUCCESS_WORDS = ['领取成功', '領取成功', '成功领取', '成功領取', '抢到了', '搶到了', '你已领取', '你已領取', '已经领取过', '已經領取過', '已领取过', '已領取過']
EMPTY_WORDS = ['红包已领完', '紅包已領完', '红包已被领完', '紅包已被領完', '红包已抢完', '紅包已搶完', '红包领完了', '紅包領完了', '红包抢完了', '紅包搶完了', '红包已过期', '紅包已過期', '红包不存在', '紅包不存在', '手慢了', '已被抢光', '已被搶光', '已经被抢光', '已經被搶光']
RED_COMMAND = re.compile(r'^/red', re.I)
PREPARING_WORDS = ['正在准备红包', '正在準備紅包', '准备红包，稍等', '準備紅包，稍等']


def contains(text, words):
    value = re.sub(r'\s+', '', str(text or '')).casefold()
    return any(re.sub(r'\s+', '', word).casefold() in value for word in words if word)


def outcome(text, rule):
    # An exhausted result must not be mistaken for a successful claim.
    if contains(text, rule.get('emptyKeywords') or EMPTY_WORDS):
        return 'exhausted'
    if contains(text, rule.get('successKeywords') or SUCCESS_WORDS):
        return 'success'
    return None


def claim_button(message, rule):
    for row_index, row in enumerate(getattr(message, 'buttons', None) or []):
        for column_index, button in enumerate(row):
            raw = getattr(button, 'button', button)
            # Telethon 1.45 / new Telegram layers wrap callbacks in button.type.
            callback = getattr(raw,'type',None)
            data = getattr(raw,'data',None) if callback is None else getattr(callback,'data',None)
            # Only callback buttons; never open links or authorize a payment/login.
            if data is not None and not getattr(callback or raw,'requires_password',False) and contains(getattr(button, 'text', ''), rule.get('buttonKeywords') or BUTTON_WORDS):
                return row_index, column_index
    return None


class RedPacketMonitor:
    """One instance per TG account shares dedupe, callback pacing and FloodWait."""
    def __init__(self, client, account, groups, emit, completed=None, persist=None, clock=time.monotonic):
        self.client, self.account, self.groups, self.emit = client, account, groups, emit
        self.completed = completed if completed is not None else {}
        self.persist, self.clock = persist, clock
        self.windows, self.messages, self.packets, self.refreshers, self.links = {}, {}, {}, {}, {}
        self.tasks, self.persistence_tasks, self.senders = set(), set(), {}
        self.callback_lock = asyncio.Lock()
        self.next_callback_at = 0
        self.flood_until = 0
        self.closed = False
        self.started_at = int(time.time())
        self.cursors = {}
        self.diagnostics = set()
        self.last_health_at = -10
        self.health = {chat: {'chatId':str(chat), 'title':group.get('title') or str(chat),
            'ruleIds':[rule['id'] for rule in group['rules']], 'received':0, 'commands':0,
            'packets':0, 'lastReceivedAt':None, 'lastMessageId':None, 'fallbackChecks':0}
            for chat, group in groups.items()}

    def report_health(self, force=False):
        if not force and self.clock()-self.last_health_at < 2:
            return
        self.last_health_at = self.clock()
        self.emit('', kind='red_packet_status', account=self.account, groups=list(self.health.values()))

    async def start(self):
        # Establish a history watermark before polling; never claim old packets.
        for chat, group in self.groups.items():
            try:
                recent = await asyncio.wait_for(self.client.get_messages(group['peer'],limit=1),15)
                self.cursors[chat] = max(self.cursors.get(chat,0),max((message.id for message in recent if message is not None),default=0))
            except Exception as error:
                wait = getattr(error,'seconds',None)
                if isinstance(wait,(int,float)) and wait > 0:
                    self.flood_until = max(self.flood_until,self.clock()+wait+1)
                self.log(group['rules'][0],f'群 {chat} 的备用检测初始化失败：{error}；仍使用实时事件监听','running','error')
        self.report_health(force=True)
        self.spawn(self.watchdog())

    def begin_window(self, chat, window_id, rules, message_id=None, origin='command'):
        key = (chat,window_id)
        if key in self.windows:
            return self.windows[key]
        if len(self.active(chat)) >= 30:
            self.log(rules[0],'当前群的红包等待队列已满，跳过本轮','failed','error')
            return None
        watch = {'id':message_id if message_id is not None else window_id,
            'deadline':self.clock()+max(rule.get('watchSeconds',120) for rule in rules),
            'started':self.clock(),'done':False,'rules':rules,'origin':origin}
        self.windows[key] = watch
        if chat not in self.refreshers:
            self.refreshers[chat] = self.spawn(self.refresh(chat))
        return watch

    def diagnose(self, chat, message_id, reason, text, rules):
        key = (chat,message_id,reason)
        if key in self.diagnostics:
            return
        if len(self.diagnostics) >= 500:
            self.diagnostics.clear()
        self.diagnostics.add(key)
        for rule in rules:
            self.log(rule,text)

    def log(self, rule, message, state='running', level='info'):
        label = f"[{rule['name']}] " if rule.get('name') else ''
        self.emit(label + message, level, account=self.account, category='red_packet', ruleId=rule['id'], state=state)

    def spawn(self, coroutine, persistence=False):
        task = asyncio.create_task(coroutine)
        pending = self.persistence_tasks if persistence else self.tasks
        pending.add(task)
        def completed(task):
            pending.discard(task)
            if not task.cancelled() and task.exception():
                self.log(next(iter(self.groups.values()))['rules'][0], f'红包监听任务异常：{task.exception()}', 'failed', 'error')
        task.add_done_callback(completed)
        return task

    def active(self, chat):
        return [watch for (group, _), watch in self.windows.items() if group == chat and not watch['done'] and watch['deadline'] > self.clock()]

    async def handle(self, event, edited=False):
        if self.closed:
            return
        message = event.message
        chat = getattr(event, 'chat_id', None) or getattr(message, 'chat_id', None)
        if chat not in self.groups:
            return
        health = self.health[chat]
        health['received'] += 1
        health['lastReceivedAt'] = time.time()
        health['lastMessageId'] = message.id
        if not edited:
            self.cursors[chat] = max(self.cursors.get(chat,0),message.id)
        if health['received'] == 1:
            for rule in self.groups[chat]['rules']:
                self.log(rule,f"已接收群 {health['title']} ({chat}) 的实时消息，消息 #{message.id}")
        self.report_health()
        await self.process(chat,message,edited=edited)

    async def process(self, chat, message, edited=False):
        if self.closed:
            return
        text = getattr(message, 'raw_text', None) or getattr(message, 'message', '') or ''
        if not edited and RED_COMMAND.match(text.strip()):
            key = (chat, message.id)
            if key in self.windows:
                return
            rules = self.groups[chat]['rules']
            date = getattr(message,'date',None)
            if date is not None and time.time()-date.timestamp() > max(rule.get('watchSeconds',120) for rule in rules):
                self.diagnose(chat,message.id,'old','跳过已超出等待窗口的旧 /red 指令',rules)
                return
            if not self.begin_window(chat,message.id,rules):
                return
            self.health[chat]['commands'] += 1
            for rule in rules:
                self.log(rule, f"发现 /red · 群 {chat} · 指令 #{message.id}，等待红包按钮")
            self.report_health(force=True)
            return
        await self.discover(chat,message)
        await self.ingest(chat, message)

    async def discover(self, chat, message):
        """Recover a fresh Bot packet when /red was deleted or its event missed."""
        reply_id = getattr(message,'reply_to_msg_id',None)
        watches = self.active(chat)
        if watches and (not reply_id or any(watch['id']==reply_id for watch in watches) or (chat,reply_id) in self.links):
            return
        rules = self.groups[chat]['rules']
        text = getattr(message,'raw_text',None) or getattr(message,'message','') or ''
        preparing = contains(text,PREPARING_WORDS)
        if not (any(claim_button(message,rule) is not None for rule in rules) or preparing or contains(text,['红包','紅包']) and getattr(message,'buttons',None)):
            return
        if self.packet_key(chat,message.id) in self.completed:
            return
        if (chat,message.id) in self.links:
            return
        date = getattr(message,'edit_date',None) or getattr(message,'date',None)
        if date is not None and time.time()-date.timestamp() > max(rule.get('watchSeconds',120) for rule in rules):
            return
        try:
            sender = await self.bot_sender(message)
        except Exception as error:
            self.diagnose(chat,message.id,'sender',f'无法核对红包 Bot 身份：{error}',rules)
            wait = getattr(error,'seconds',None)
            if isinstance(wait,(int,float)) and wait > 0:
                self.flood_until = max(self.flood_until,self.clock()+wait+1)
            return
        if not getattr(sender,'bot',False):
            return
        matched = [rule for rule in rules if self.matches_bot(sender,rule)]
        if not matched:
            self.diagnose(chat,message.id,'bot',f"发现红包消息，但 Bot @{getattr(sender,'username',None) or getattr(sender,'id','未知')} 与规则指定的 Bot 不匹配，请核对用户名",rules)
            return
        if not preparing and not any(claim_button(message,rule) is not None for rule in matched):
            self.diagnose(chat,message.id,'button','收到 Bot 红包按钮，但未匹配可领取的回调按钮，请核对“领取按钮识别词”',matched)
            return
        watch = self.begin_window(chat,f'packet:{message.id}',matched,message_id=message.id-1,origin='packet')
        if watch:
            self.links[(chat,message.id)] = watch
            if reply_id:
                self.links[(chat,reply_id)] = watch
            for rule in matched:
                self.log(rule,f'直接检测到 Bot 红包 · 群 {chat} · 消息 #{message.id}（/red 可能已删除或漏收），开始本轮检测')

    @staticmethod
    def matches_bot(sender,rule):
        if not rule.get('botUsername'):
            return True
        names = [getattr(sender,'username','')]
        names.extend(getattr(item,'username','') for item in getattr(sender,'usernames',None) or [] if getattr(item,'active',False))
        return rule['botUsername'].lstrip('@').casefold() in {str(name or '').casefold() for name in names}

    async def bot_sender(self, message):
        sender_id = getattr(message, 'sender_id', None)
        if sender_id in self.senders:
            return self.senders[sender_id]
        sender = getattr(message, 'sender', None)
        if sender is None and hasattr(message, 'get_sender'):
            sender = await message.get_sender()
        if sender is not None and sender_id is not None:
            if len(self.senders) >= 200:
                self.senders.pop(next(iter(self.senders)))
            self.senders[sender_id] = sender
        return sender

    async def ingest(self, chat, message):
        watches = self.active(chat)
        if not watches or not getattr(message, 'id', None):
            return
        key = (chat, message.id)
        if message.id <= min(watch['id'] for watch in watches):
            return
        text = getattr(message, 'raw_text', None) or getattr(message, 'message', '') or ''
        all_rules = self.groups[chat]['rules']
        if not (any(claim_button(message, rule) for rule in all_rules) or contains(text, ['红包','紅包']) or any(outcome(text,rule) == 'exhausted' for rule in all_rules)):
            return
        watch = self.links.get(key)
        if watch is not None:
            # Edits belong to the original packet, even if newer /red commands
            # arrived between preparation, the button and the exhausted caption.
            if watch['done'] or watch['deadline'] <= self.clock():
                return
        else:
            reply_id = getattr(message, 'reply_to_msg_id', None)
            linked = [watch for watch in watches if watch['id'] == reply_id]
            # A reply to an older command/packet must never consume a newer window.
            if reply_id and not linked:
                parent = self.links.get((chat,reply_id))
                linked = [parent] if parent and not parent['done'] else []
                if not linked:
                    return
            watch = max(linked or [item for item in watches if item['id'] < message.id], key=lambda item:item['id'])
        try:
            sender = await self.bot_sender(message)
        except Exception as error:
            wait = getattr(error, 'seconds', None)
            if isinstance(wait, (int, float)) and wait > 0:
                self.flood_until = max(self.flood_until, self.clock() + wait + 1)
                self.log(watch['rules'][0], f'Telegram 身份查询限流，等待 {wait} 秒', 'running', 'error')
            return
        if watch['done'] or not getattr(sender, 'bot', False):
            return
        rules = [rule for rule in watch['rules'] if self.clock() < watch['started']+rule.get('watchSeconds',120) and
                 self.matches_bot(sender,rule)]
        if not rules:
            self.diagnose(chat,message.id,'bot',f"跳过红包 Bot @{getattr(sender,'username',None) or getattr(sender,'id','未知')}：与规则指定的 Bot 不匹配或等待窗口已结束",watch['rules'])
            return
        self.messages[key] = message
        self.links[key] = watch
        if len(self.messages) > 500:
            self.messages.pop(next(iter(self.messages)))
        terminal = next((rule for rule in rules if outcome(text,rule) == 'exhausted'), None)
        if terminal:
            await self.finish(chat,message.id,watch,terminal,'exhausted',text)
            return
        rule = next((rule for rule in rules if claim_button(message,rule) is not None), None)
        if not rule and getattr(message,'buttons',None):
            self.diagnose(chat,message.id,'button','收到 Bot 按钮，但未匹配领取按钮识别词，请核对“领取按钮识别词”',rules)
        if not rule or key in self.packets:
            return
        stored_key = self.packet_key(chat,message.id)
        if stored_key in self.completed:
            watch['done'] = True
            return
        packet = {'watch':watch,'rule':rule,'done':False,'attempts':0}
        self.packets[key] = packet
        self.health[chat]['packets'] += 1
        self.report_health(force=True)
        self.log(rule, f"红包按钮已出现 · 群 {chat} · 消息 #{message.id}，立即领取")
        self.spawn(self.claim(chat,message.id,packet))

    def packet_key(self, chat, message_id):
        return f'{self.account}:{chat}:{message_id}'

    async def finish(self, chat, message_id, watch, rule, result, text):
        # A callback confirming our own claim takes precedence over a concurrent
        # group edit announcing that the last packet was taken.
        if watch['done'] and not (result == 'success' and watch.get('result') == 'exhausted'):
            return
        watch['done'] = True
        watch['result'] = result
        record = {'time':time.time(),'result':result}
        self.completed[self.packet_key(chat,message_id)] = record
        for (group, packet_id), active_packet in self.packets.items():
            if group == chat and active_packet['watch'] is watch:
                active_packet['done'] = True
                self.completed[self.packet_key(chat,packet_id)] = record
        label = '领取成功或已领取' if result == 'success' else '红包已领完或失效'
        self.log(rule, f"{label} · 群 {chat} · 消息 #{message_id} · {str(text)[:250]}，停止本轮刷新，继续监听", 'completed')
        if self.persist:
            async def save():
                try:
                    await self.persist()
                except Exception as error:
                    self.log(rule, f'领取结果保存失败：{error}', 'failed', 'error')
            self.spawn(save(), persistence=True)

    async def claim(self, chat, message_id, packet):
        watch, rule = packet['watch'], packet['rule']
        deadline = watch['started']+rule.get('watchSeconds',120)
        try:
            while not self.closed and not watch['done'] and self.clock() < deadline:
                async with self.callback_lock:
                    wait = max(0,self.next_callback_at-self.clock(),self.flood_until-self.clock())
                    if wait:
                        await asyncio.sleep(min(wait,max(0,deadline-self.clock())))
                    if self.closed or watch['done'] or self.clock() >= deadline:
                        break
                    message = self.messages.get((chat,message_id))
                    button = claim_button(message,rule)
                    if button is None:
                        self.next_callback_at = self.clock()+rule.get('retryInterval',0.5)
                        continue
                    packet['attempts'] += 1
                    try:
                        answer = await asyncio.wait_for(message.click(i=button[0],j=button[1]),timeout=min(10,max(0.01,deadline-self.clock())))
                        result_text = getattr(answer,'message','') or ''
                        result = outcome(result_text,rule)
                        if result:
                            await self.finish(chat,message_id,watch,rule,result,result_text)
                            return
                        if packet['attempts'] == 1:
                            self.log(rule, f"领取尚未确认 · 群 {chat} · 消息 #{message_id} · {str(result_text or '等待 Bot 返回结果')[:200]}")
                    except Exception as error:
                        wait = getattr(error,'seconds',None)
                        if isinstance(wait,(int,float)) and wait > 0:
                            self.next_callback_at = self.clock()+wait+1
                            self.flood_until = self.next_callback_at
                            self.log(rule,f'Telegram 限流，等待 {wait} 秒后继续领取','running','error')
                        elif type(error).__name__ in ('MessageIdInvalidError','MessageNotModifiedError','QueryIdInvalidError','DataInvalidError'):
                            watch['done'] = True
                            self.log(rule,f'红包按钮已失效 · 群 {chat} · 消息 #{message_id}，继续监听','completed')
                            return
                        elif type(error).__name__ in ('BotResponseTimeoutError','TimeoutError','ConnectionError','OSError'):
                            if packet['attempts'] == 1:
                                self.log(rule,'Bot 暂未响应，继续等待红包更新')
                        else:
                            watch['done'] = True
                            self.log(rule,f'领取失败 · 群 {chat} · 消息 #{message_id}：{error}','failed','error')
                            return
                    self.next_callback_at = max(self.next_callback_at,self.clock()+rule.get('retryInterval',0.5))
        finally:
            packet['done'] = True
            # Keep the packet key until its window expires, so duplicate edits cannot spawn a second claim loop.

    async def refresh(self, chat):
        peer = self.groups[chat]['peer']
        try:
            while not self.closed:
                await asyncio.sleep(1)
                watches = self.active(chat)
                for (group,_), watch in list(self.windows.items()):
                    if group != chat or watch['done'] or watch['deadline'] > self.clock():
                        continue
                    watch['done'] = True
                    for rule in watch['rules']:
                        self.log(rule,f"本轮红包等待超时 · 群 {chat} · 指令 #{watch['id']}，停止刷新，继续监听", 'completed')
                self.prune(chat)
                if not watches:
                    break
                if self.clock() < self.flood_until:
                    continue
                try:
                    messages = await self.client.get_messages(peer,limit=20,min_id=min(watch['id'] for watch in watches))
                    for message in sorted((item for item in messages if item is not None),key=lambda item:item.id):
                        await self.ingest(chat,message)
                    seen = {item.id for item in messages if item is not None}
                    tracked = [key[1] for key,watch in self.links.items() if key[0]==chat and not watch['done'] and key[1] not in seen][-30:]
                    if tracked and self.clock() >= self.flood_until:
                        updates = await self.client.get_messages(peer,ids=tracked)
                        for message in updates:
                            if message is not None:
                                await self.ingest(chat,message)
                except Exception as error:
                    wait = getattr(error,'seconds',None)
                    if isinstance(wait,(int,float)) and wait > 0:
                        self.flood_until = max(self.flood_until,self.clock()+wait+1)
                        self.log(watches[0]['rules'][0],f'Telegram 刷新限流，等待 {wait} 秒','running','error')
                    else:
                        self.log(watches[0]['rules'][0],f'临时刷新失败：{error}','running','error')
                        await asyncio.sleep(4)
        finally:
            self.refreshers.pop(chat,None)
            self.prune(chat)

    async def watchdog(self):
        """Low-rate safety net for stalled Telegram updates, with no history replay."""
        while not self.closed:
            await asyncio.sleep(5)
            for chat, group in self.groups.items():
                if self.closed:
                    return
                if self.active(chat) or self.clock() < self.flood_until:
                    continue
                health = self.health[chat]
                if health['lastReceivedAt'] and time.time()-health['lastReceivedAt'] < 5:
                    continue
                try:
                    if chat not in self.cursors:
                        recent = await asyncio.wait_for(self.client.get_messages(group['peer'],limit=1),15)
                        self.cursors[chat] = max((message.id for message in recent if message is not None),default=0)
                        continue
                    messages = await asyncio.wait_for(self.client.get_messages(group['peer'],limit=50,min_id=self.cursors[chat]),15)
                    health['fallbackChecks'] += 1
                    for message in sorted((item for item in messages if item is not None),key=lambda item:item.id):
                        if message.id <= self.cursors[chat]:
                            continue
                        self.cursors[chat] = message.id
                        await self.process(chat,message)
                    self.report_health()
                except Exception as error:
                    wait = getattr(error,'seconds',None)
                    if isinstance(wait,(int,float)) and wait > 0:
                        self.flood_until = max(self.flood_until,self.clock()+wait+1)
                        self.log(group['rules'][0],f'备用检测触发 Telegram 限流，等待 {wait} 秒','running','error')
                    else:
                        self.diagnose(chat,0,'watchdog',f'群 {chat} 的备用检测失败：{error}',group['rules'])

    def prune(self, chat):
        self.windows = {key:watch for key,watch in self.windows.items() if key[0]!=chat or not watch['done']}
        closed = {key for key,watch in self.links.items() if key[0]==chat and watch['done']}
        for key in closed:
            self.messages.pop(key,None)
            self.packets.pop(key,None)
            self.links.pop(key,None)

    async def close(self):
        self.closed = True
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        # Completed results are flushed before disconnect/restart, without
        # making database latency delay the next live callback.
        if self.persistence_tasks:
            await asyncio.gather(*list(self.persistence_tasks),return_exceptions=True)
