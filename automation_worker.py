#!/usr/bin/env python3
"""Long-running Telegram scheduler and new-message forwarder."""

from telegram_credentials import resolve_credentials
from outgoing_proxy import telegram_proxy_kwargs, install_network_guard
from storage import read_document, write_document, database_enabled, parse_config_text
import asyncio
import datetime as dt
import json
import os
import re
import random
import signal
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("AUTOCHECKIN_DATA_DIR") or ROOT)
CONFIG_PATH = DATA_DIR / "config.json"
STATE_PATH = DATA_DIR / ".automation-state.json"
PACKET_STATE_PATH = DATA_DIR / ".red-packet-state.json"
_last_database_state = None
CHINA_TIME = dt.timezone(dt.timedelta(hours=8))


def emit(message, level="info", kind="log", **metadata):
    print(json.dumps({"type": kind, "level": level, "message": str(message), **metadata}, ensure_ascii=False), flush=True)


def emit_rule(rule, category, message, level="info", state=None):
    emit(message, level, account=rule['account'], category=category, ruleId=rule['id'],
         state=state or ('failed' if level == 'error' else 'completed'))


def load_config():
    return read_document('config', CONFIG_PATH, parser=parse_config_text)


def load_state():
    try:
        data = read_document('automation-state', STATE_PATH, default={})
        return {name: data[name] if isinstance(data, dict) and isinstance(data.get(name), dict) else {} for name in ("sent", "planned", "claimed")}
    except (FileNotFoundError, ValueError):
        return {"sent": {}, "planned": {}, "claimed": {}}


def load_sent():
    return load_state()["sent"]


def packet_state(data):
    if not isinstance(data, dict):
        return {}
    cutoff = time.time() - 7 * 86400
    entries = [(key, value) for key, value in data.items() if isinstance(value, dict)
               and isinstance(value.get('time'), (int, float)) and value['time'] > cutoff]
    return dict(sorted(entries, key=lambda item: item[1]['time'])[-2000:])


def save_sent(sent, planned=None, claimed=None):
    global _last_database_state
    data = {"sent": sent, "planned": planned or {}, "claimed": claimed or {}}
    if database_enabled():
        serialized = json.dumps(data, ensure_ascii=False, sort_keys=True)
        if serialized == _last_database_state:
            return
        write_document('automation-state', data)
        _last_database_state = serialized
        return
    serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if STATE_PATH.exists() and STATE_PATH.read_text(encoding="utf-8") == serialized:
        return
    temp = STATE_PATH.with_suffix(".tmp")
    temp.write_text(serialized, encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, STATE_PATH)


def clock_seconds(value):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?", value):
        raise ValueError("Invalid schedule time")
    parts = [int(part) for part in value.split(":")]
    return parts[0] * 3600 + parts[1] * 60 + (parts[2] if len(parts) == 3 else 0)


def plan_schedules(schedules, now, planned, claimed, rng=random.randint):
    active = set()
    for rule in schedules:
        if rule.get("enabled", True) is False or rule["repeat"] != "daily" or rule.get("timeMode") != "random":
            continue
        key = json.dumps([rule["account"], rule["id"], now.date().isoformat()], separators=(",", ":"))
        active.add(key)
        signature = [rule["rangeStart"], rule["rangeEnd"]]
        if key not in planned or (planned[key]["signature"] != signature and key not in claimed):
            start, end = clock_seconds(rule["rangeStart"]), clock_seconds(rule["rangeEnd"])
            if start > end:
                raise ValueError("Random interval must not cross midnight")
            value = rng(start, end)
            planned[key] = {"account": rule["account"], "ruleId": rule["id"], "date": now.date().isoformat(),
                            "time": f"{value // 3600:02}:{value // 60 % 60:02}:{value % 60:02}", "signature": signature}
    for key in list(planned):
        if key not in active:
            del planned[key]
    return planned


def chat_value(value):
    text = str(value)
    return int(text) if re.fullmatch(r"-?\d+", text) else text


def matches_keywords(message, keywords):
    """Literal, case-insensitive OR matching in message text / media captions."""
    if not keywords:
        return True
    text = message if isinstance(message, str) else getattr(message, 'raw_text', None) or getattr(message, 'message', '')
    text = str(text or '').casefold()
    return any(str(keyword).casefold() in text for keyword in keywords if str(keyword).strip())


async def forward_message(rule, client, target, message, source):
    label = f"[{rule['name']}] " if rule.get('name') else ''

    async def retry(operation, stage):
        while True:
            try:
                return await operation()
            except Exception as error:
                wait = getattr(error, 'seconds', None)
                if not isinstance(wait, int) or not 0 < wait <= 3600:
                    raise
                emit_rule(rule, 'forward', f"{label}{stage}触发 Telegram 限流，等待 {wait} 秒后重试", 'error', state='running')
                await asyncio.sleep(wait + 1)

    try:
        forwarded = await retry(lambda: client.forward_messages(target, message), '转发')
    except Exception as error:
        emit_rule(rule, 'forward', f"{label}转发 {source} → {rule['target']} 失败：{error}", 'error')
        return
    if rule.get('pinAfterForward') is True:
        try:
            pinned = next((item for item in reversed(forwarded) if item is not None), None) if isinstance(forwarded, (list, tuple)) else forwarded
            if pinned is None:
                raise ValueError('未返回目标消息，无法置顶')
            await retry(lambda: client.pin_message(target, pinned, notify=False), '置顶')
        except Exception as error:
            emit_rule(rule, 'forward', f"{label}消息已转发 {source} → {rule['target']}，但置顶失败（请检查目标会话的置顶权限）：{error}", 'error')
            return
        emit_rule(rule, 'forward', f"{label}已转发并置顶 {source} 的新消息至 {rule['target']}")
    else:
        emit_rule(rule, 'forward', f"{label}已转发 {source} 的新消息至 {rule['target']}")


def occurrence(rule, now, plan=None):
    """Daily minute legacy: 60s; seconds/random: 10s; once: 300s."""
    value = plan["time"] if rule.get("timeMode") == "random" and plan else rule.get("time")
    if not value:
        return None
    if rule["repeat"] == "daily":
        scheduled = now.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(seconds=clock_seconds(value))
        grace = 60 if len(value) == 5 and rule.get("timeMode", "fixed") == "fixed" else 10
        result = now.date().isoformat()
    else:
        scheduled = dt.datetime.fromisoformat(value).replace(tzinfo=CHINA_TIME)
        grace, result = 300, value
    seconds = (now - scheduled).total_seconds()
    return result if 0 <= seconds < grace else None


async def main():
    try:
        from telethon import TelegramClient, events
    except ImportError as error:
        emit(f"缺少 Python 依赖：{error}。请安装 requirements.txt。", "error", "fatal")
        return 2

    config = load_config()
    rules = config.get("automations") or {}
    schedules = [rule for rule in rules.get("schedules", []) if rule.get("enabled", True)]
    forwards = [rule for rule in [*rules.get("forwards", []), *rules.get("forwardPins", [])] if rule.get("enabled", True)]
    red_packets = [rule for rule in rules.get('redPackets', []) if rule.get('enabled', True)]
    required = {rule["account"] for rule in schedules + forwards + red_packets}
    users = {str(user.get("session") or user["name"]): user for user in config.get("telegram", {}).get("users", [])}
    clients = {}
    forward_tasks = []
    schedule_tasks = set()
    connected_clients = []
    packet_monitors = []
    persisted = load_state()
    sent, planned, claimed = (persisted[name] for name in ("sent", "planned", "claimed"))
    last_plans = None
    in_flight = set()
    retry_after = {}

    def account_error(session, message):
        for category, entries in [('message', schedules), ('forward', forwards), ('red_packet', red_packets)]:
            for rule in entries:
                if rule['account'] == session:
                    emit_rule(rule, category, message, 'error')

    try:
        for session in required:
            user = users.get(session)
            if not user:
                account_error(session, f"账号 {session} 不存在，跳过其规则")
                continue
            api_id, api_hash = resolve_credentials(config, user)
            # Red packet detection is driven by pushed NewMessage/MessageEdited events;
            # history polling is only a fallback, never the primary listener.
            packet_options = {'flood_sleep_threshold': 0, 'receive_updates': True, 'sequential_updates': False} if any(rule['account'] == session for rule in red_packets) else {}
            client = TelegramClient(str(DATA_DIR / session), api_id, api_hash, device_model="AutoCheckin", **packet_options, **telegram_proxy_kwargs(user))
            connected_clients.append(client)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    account_error(session, f"账号 {session} 尚未登录，请先在账号管理中完成登录")
                    await client.disconnect()
                    connected_clients.remove(client)
                    continue
            except Exception as error:
                account_error(session, f"账号 {session} 连接失败：{error}")
                await client.disconnect()
                connected_clients.remove(client)
                continue
            clients[session] = client
            emit(f"账号 {session} 已连接")

        if not clients:
            emit("没有可用的已登录账号，自动化无法启动", "error", "fatal")
            return 2

        active_forwards = 0
        for rule in forwards:
            client = clients.get(rule["account"])
            if not client:
                continue
            source_values = rule.get('sources') or [rule['source']]
            source_label = '、'.join(source_values)
            try:
                target = await client.get_input_entity(chat_value(rule["target"]))
            except Exception as error:
                emit_rule(rule, 'forward', f"转发规则 {source_label} → {rule['target']} 无法解析目标会话：{error}", "error")
                continue
            sources = []
            for value in source_values:
                try:
                    source = await client.get_input_entity(chat_value(value))
                    if source == target:
                        raise ValueError('来源和目标指向同一会话')
                    if source not in sources:
                        sources.append(source)
                except Exception as error:
                    emit_rule(rule, 'forward', f"监听来源 {value} 无法启用：{error}", 'error')
            if not sources:
                continue

            queue = asyncio.Queue(maxsize=500)

            async def forward_loop(*, rule=rule, client=client, target=target, queue=queue, source_label=source_label):
                while True:
                    message = await queue.get()
                    try:
                        await forward_message(rule, client, target, message, source_label)
                    finally:
                        queue.task_done()

            async def forward_handler(event, *, rule=rule, queue=queue, source_label=source_label):
                if not matches_keywords(event.message, rule.get('keywords', [])):
                    return
                try:
                    queue.put_nowait(event.message)
                except asyncio.QueueFull:
                    emit_rule(rule, 'forward', f"转发队列已满，无法处理 {source_label} 的新消息", "error")

            client.add_event_handler(forward_handler, events.NewMessage(chats=sources if rule.get('sources') else sources[0]))
            forward_tasks.append(asyncio.create_task(forward_loop()))
            active_forwards += 1
            matching = f"任意关键词：{'、'.join(rule['keywords'])}" if rule.get('keywords') else '全部新消息'
            emit_rule(rule, 'forward', f"开始监听 {source_label} → {rule['target']} · {matching}" + (' · 转发后置顶' if rule.get('pinAfterForward') is True else ''))

        active_packets = 0
        if red_packets:
            from red_packet import RedPacketMonitor
            from telethon import utils, types
            completed_packets = packet_state(read_document('red-packet-state', PACKET_STATE_PATH, default={}))
            packet_save_lock = asyncio.Lock()

            async def persist_packets():
                async with packet_save_lock:
                    retained = packet_state(completed_packets)
                    completed_packets.clear()
                    completed_packets.update(retained)
                    await asyncio.to_thread(write_document, 'red-packet-state', dict(retained), PACKET_STATE_PATH)

            for account, client in clients.items():
                groups = {}
                dialogs = None

                async def resolve_group(value):
                    nonlocal dialogs
                    reference = chat_value(value)
                    try:
                        return await asyncio.wait_for(client.get_entity(reference), 15)
                    except ValueError:
                        if not isinstance(reference, int):
                            raise
                        if dialogs is None:
                            dialogs = await asyncio.wait_for(client.get_dialogs(limit=None), 20)
                        entity = next((dialog.entity for dialog in dialogs if utils.get_peer_id(dialog.entity) == reference), None)
                        if entity is None:
                            raise ValueError('输入错误或账号未加入')
                        return entity

                for rule in red_packets:
                    if rule['account'] != account:
                        continue
                    valid = False
                    for value in rule['groups']:
                        try:
                            entity = await resolve_group(value)
                            if not (isinstance(entity, types.Chat) or isinstance(entity, types.Channel) and entity.megagroup):
                                raise ValueError('请选择群组，广播频道和私聊不支持抢红包')
                            if getattr(entity, 'left', False):
                                raise ValueError('输入错误或账号未加入')
                            peer = await client.get_input_entity(entity)
                            chat = utils.get_peer_id(peer)
                            group = groups.setdefault(chat, {'peer': peer, 'title':getattr(entity,'title',str(chat)), 'rules': []})
                            if rule not in group['rules']:
                                group['rules'].append(rule)
                            valid = True
                        except Exception as error:
                            emit_rule(rule, 'red_packet', f"监听群组 {value} 无法启用：{error}", 'error')
                    if valid:
                        active_packets += 1
                if not groups:
                    continue
                monitor = RedPacketMonitor(client, account, groups, emit, completed_packets, persist_packets)
                packet_monitors.append(monitor)

                async def packet_handler(event, *, monitor=monitor):
                    try:
                        await monitor.handle(event)
                    except Exception as error:
                        for rule in monitor.groups.get(event.chat_id,{}).get('rules',[]):
                            monitor.log(rule,f'红包新消息处理失败：{error}','failed','error')

                async def packet_edit_handler(event, *, monitor=monitor):
                    try:
                        await monitor.handle(event, edited=True)
                    except Exception as error:
                        for rule in monitor.groups.get(event.chat_id,{}).get('rules',[]):
                            monitor.log(rule,f'红包消息编辑处理失败：{error}','failed','error')

                client.add_event_handler(packet_handler, events.NewMessage(chats=list(groups)))
                client.add_event_handler(packet_edit_handler, events.MessageEdited(chats=list(groups)))
                await monitor.start()
                registered = {rule['id']:rule for group in groups.values() for rule in group['rules']}
                for rule in registered.values():
                    labels = '、'.join(f"{group['title']} ({chat})" for chat,group in groups.items() if rule in group['rules'])
                    emit_rule(rule, 'red_packet', f"[{rule.get('name') or rule['id']}] 开始监听 /red 红包指令 · {labels} · Bot {rule.get('botUsername') or '不限'} · 启用漏收备用检测", state='running')

        emit(f"自动化运行中：{len(schedules)} 条定时消息，{active_forwards} 条转发监听，{active_packets} 条红包监听", kind="ready")

        async def send_schedule(rule, key):
            try:
                client = clients[rule["account"]]
                target = await client.get_input_entity(chat_value(rule["target"]))
                await client.send_message(target, rule["message"])
                sent[key] = dt.datetime.now(CHINA_TIME).isoformat(timespec="seconds")
                save_sent(sent, planned, claimed)
                emit_rule(rule, 'message', f"定时消息已发送至 {rule['target']}")
            except Exception as error:
                wait = getattr(error, "seconds", None)
                retry_after[key] = time.monotonic() + (wait + 1 if isinstance(wait, int) and wait > 0 else 30)
                emit_rule(rule, 'message', f"定时消息发送至 {rule['target']} 失败：{error}", "error")
            finally:
                in_flight.discard(key)

        while True:
            now = dt.datetime.now(CHINA_TIME)
            # Commit plans before exposing or dispatching; failed writes dispatch nothing.
            try:
                plan_schedules(schedules, now, planned, claimed)
                active_keys = {json.dumps([r["account"], r["id"], now.date().isoformat() if r["repeat"] == "daily" else r["time"]], separators=(",", ":")) for r in rules.get("schedules", [])}
                claimed = {key: value for key, value in claimed.items() if key in active_keys}
                save_sent(sent, planned, claimed)
            except Exception as error:
                emit(f"计划保存失败，不执行定时消息：{error}", "error")
                persisted = load_state()
                sent, planned, claimed = (persisted[name] for name in ("sent", "planned", "claimed"))
                await asyncio.sleep(1)
                continue
            public_plans = [{k: v for k, v in plan.items() if k != "signature"} for plan in planned.values()]
            if public_plans != last_plans:
                print(json.dumps({"type": "planned", "planned": public_plans}, ensure_ascii=False), flush=True)
                last_plans = public_plans
            for rule in schedules:
                if rule["account"] not in clients:
                    continue
                plan_key = json.dumps([rule["account"], rule["id"], now.date().isoformat() if rule["repeat"] == "daily" else rule["time"]], separators=(",", ":"))
                due = occurrence(rule, now, planned.get(plan_key))
                if not due:
                    continue
                key = plan_key
                legacy_key = f"{rule['id']}|{rule.get('time', '')}|{due}"
                if key in sent or legacy_key in sent or key in claimed or key in in_flight or time.monotonic() < retry_after.get(key, 0):
                    continue
                # At-most-once dispatch, including crash during send. Persistence failure
                # must never reach Telegram. A failed send is not automatically retried.
                claimed[key] = now.isoformat(timespec="seconds")
                try:
                    save_sent(sent, planned, claimed)
                except Exception as error:
                    claimed.pop(key, None)
                    emit_rule(rule, 'message', f"执行记录保存失败，不发送消息：{error}", "error")
                    continue
                in_flight.add(key)
                task = asyncio.create_task(send_schedule(rule, key))
                schedule_tasks.add(task)
                task.add_done_callback(schedule_tasks.discard)
            await asyncio.sleep(1)
    finally:
        for monitor in packet_monitors:
            await monitor.close()
        tasks = [*forward_tasks, *schedule_tasks]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        # Include clients whose connect/authorization was interrupted.
        results = await asyncio.gather(
            *(client.disconnect() for client in connected_clients),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, Exception):
                emit(f"账号断开失败：{result}", "error")


async def run_until_stopped():
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(main())
    try:
        loop.add_signal_handler(signal.SIGTERM, task.cancel)
    except (NotImplementedError, RuntimeError):
        pass  # Windows TerminateProcess has no graceful SIGTERM delivery.
    try:
        return await task
    except asyncio.CancelledError:
        return 0
    finally:
        try:
            loop.remove_signal_handler(signal.SIGTERM)
        except NotImplementedError:
            pass


if __name__ == "__main__":
    try:
        install_network_guard()
        sys.exit(asyncio.run(run_until_stopped()))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        emit(f"自动化进程异常：{error}", "error", "fatal")
        sys.exit(2)
