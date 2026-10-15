"""Bounded, explicit interaction with Telegram's official @SpamBot only."""
import asyncio
import re


def body(message):
    return str(getattr(message, 'raw_text', '') or getattr(message, 'message', '') or '')[:5000]


def classify(text):
    value = text.casefold()
    if re.search(r'no (?:limits|limitations|restrictions) (?:are )?(?:currently )?(?:applied|on your account)|free as a bird|your account is free from|account (?:is not|isn.t|is currently not) limited|目前[没有无]+任何限制|(?:账号|帐号|账户).{0,12}(?:没有|未受|不受).{0,5}限制', value):
        return 'clear'
    if re.search(r'(?:account (?:is (?:(?:currently|now|temporarily) )?|has been |was |currently )(?:temporarily )?limited|only (?:send|message).{0,80}mutual contacts|(?:账号|帐号|账户).{0,20}(?:已被限制|受到限制|被限制|受限)|只能.{0,40}(?:双向|互为|相互).{0,15}联系人)', value):
        return 'limited'
    return 'unknown'


def submitted(text):
    return bool(re.search(r'complaint (?:has been |was )?(?:successfully )?submitted|appeal (?:has been |was )?(?:successfully )?submitted|(?:申诉|投诉).{0,10}(?:已成功提交|已提交|已收到)|thank you.{0,30}(?:review|moderators)', text.casefold()))


def pending(text):
    return bool(re.search(r'already (?:submitted|sent).{0,30}(?:complaint|appeal)|(?:complaint|appeal).{0,40}(?:being reviewed|under review)|(?:申诉|投诉).{0,15}(?:审核中|已在处理|已经提交)', text.casefold()))


def needs_human(text):
    return bool(re.search(r'captcha|verify (?:that )?you are human|verification code|验证码|人机验证|two.step|password|登录密码', text.casefold()))


def next_button(message, pledge):
    prompt = body(message).casefold()
    for row in getattr(message, 'buttons', None) or []:
        for button in row:
            text = str(button.text).strip()
            value = text.casefold().rstrip('!.。！')
            if getattr(getattr(button, 'button', None), 'url', None):
                continue
            if value in {'this is a mistake', '这是一个错误', '这是误封', '这是个错误', '这是一个误会', '这是误会'}:
                return button
            if value in {'yes', '是', '是的'} and re.search(r'(?:submit|send|file).{0,35}(?:complaint|appeal)|(?:提交|发送).{0,10}(?:申诉|投诉)', prompt):
                return button
            if pledge and value in {"no, i'll never do any of this", 'no, i’ll never do any of this', '不，我绝不会这样做', '不，我永远不会这样做'}:
                return button
    return None


def asks_for_appeal(text):
    return bool(re.search(r'(?:please (?:write|tell|explain|describe)|tell us (?:more|why)|write.{0,30}(?:complaint|appeal))|请.{0,12}(?:描述|说明|解释|告诉)', text.casefold()))


def signature(message):
    return (message.id, body(message), tuple(str(button.text) for row in getattr(message, 'buttons', None) or [] for button in row))


async def wait_reply(client, peer, after, previous=None, timeout=9):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        messages = await asyncio.wait_for(client.get_messages(peer, limit=8), 10)
        incoming = [message for message in messages if not getattr(message, 'out', False) and message.id >= after and signature(message) != previous]
        if incoming:
            return max(incoming, key=lambda message: message.id)
        await asyncio.sleep(0.8)
    return None


async def run(client, action, appeal_text='', pledge=False):
    if action not in {'spam_check', 'spam_appeal'}:
        raise ValueError('Unsupported SpamBot operation')
    if action == 'spam_appeal' and (not pledge or not 10 <= len(appeal_text.strip()) <= 2000):
        return {'status': 'action_blocked', 'detail': '请先确认申诉声明并填写 10–2000 字的真实申诉内容'}
    peer = await asyncio.wait_for(client.get_entity('SpamBot'), 12)
    if not getattr(peer, 'bot', False) or str(getattr(peer, 'username', '')).casefold() != 'spambot':
        return {'status': 'action_blocked', 'detail': '无法确认官方 @SpamBot，已停止操作'}
    logs = []
    sent_text = False
    current_status = 'unknown'
    reply = ''

    def result(state, detail):
        return {'status': 'reachable', 'detail': detail, 'spam': {'status': current_status, 'reply': reply, 'appealState': state, 'appealSent': sent_text, 'logs': logs}}

    try:
        command = await asyncio.wait_for(client.send_message(peer, '/start'), 12)
        logs.append('已向官方 @SpamBot 发送 /start，等待账号限制状态')
        message = await wait_reply(client, peer, command.id)
        if not message:
            return result('unconfirmed', '未收到新的 SpamBot 回复，请稍后查询')
        for _ in range(8):
            reply = body(message)
            detected = classify(reply)
            if detected != 'unknown':
                current_status = detected
            if current_status == 'clear':
                return result('not_needed', 'SpamBot 表示当前没有垃圾信息限制，无需提交申诉')
            if pending(reply):
                return result('pending', 'SpamBot 表示已有申诉正在处理，请等待审核')
            if submitted(reply):
                return result('submitted', 'SpamBot 已确认收到申诉，等待 Telegram 审核')
            if action == 'spam_check':
                return result('none', 'SpamBot 返回账号存在限制' if current_status == 'limited' else '未能识别 SpamBot 的限制状态，请查看原始回复')
            if needs_human(reply):
                return result('manual', 'SpamBot 要求验证或人工处理，请在 Telegram 中打开 @SpamBot 继续')
            button = next_button(message, pledge)
            previous = signature(message)
            after = message.id
            if button:
                # URL/web-app buttons are never followed. Only named official appeal steps.
                response = await asyncio.wait_for(button.click(), 12)
                if getattr(response, 'out', False):
                    after = response.id
                logs.append('已选择申诉步骤：' + str(button.text)[:100])
            elif asks_for_appeal(reply) and not sent_text:
                command = await asyncio.wait_for(client.send_message(peer, appeal_text.strip()), 12)
                sent_text = True
                after = command.id
                logs.append('已发送你确认的申诉内容，等待官方确认')
            else:
                return result('sent_unconfirmed' if sent_text else 'manual', '申诉文字已发送，但尚未收到受理确认，请到 @SpamBot 核实' if sent_text else 'SpamBot 当前提问需要本人处理，已停止自动操作，请在 Telegram 中继续')
            message = await wait_reply(client, peer, after, previous)
            if not message:
                return result('sent_unconfirmed' if sent_text else 'manual', '未收到后续回复，请打开 @SpamBot 核实；不会自动重复提交')
        return result('manual', '已达到本次交互步数上限，请在 Telegram 中继续')
    except Exception as error:
        from account_security import error_result
        failure = error_result(error)
        failure['spam'] = {'status': current_status, 'reply': reply, 'appealState': 'sent_unconfirmed' if sent_text else 'error', 'appealSent': sent_text, 'logs': logs}
        return failure
