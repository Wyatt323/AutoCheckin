#!/usr/bin/env python3
"""Long-running Telegram scheduler and new-message forwarder."""

from telegram_credentials import resolve_credentials
import asyncio
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("AUTOCHECKIN_DATA_DIR") or ROOT)
CONFIG_PATH = DATA_DIR / "config.json"
STATE_PATH = DATA_DIR / ".automation-state.json"
CHINA_TIME = dt.timezone(dt.timedelta(hours=8))


def emit(message, level="info", kind="log"):
    print(json.dumps({"type": kind, "level": level, "message": str(message)}, ensure_ascii=False), flush=True)


def parse_config_text(text):
    """Accept full-line # comments and trailing commas, never edit strings."""
    output = []
    in_string = escaped = False
    line_start = True
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
            output.append(char)
        elif char == '#' and line_start:
            while index < len(text) and text[index] != '\n':
                index += 1
            continue
        elif char == ',':
            following = index + 1
            while following < len(text):
                if text[following].isspace():
                    following += 1
                elif text[following] == '#' and text[text.rfind('\n', 0, following) + 1:following].strip() == '':
                    end = text.find('\n', following)
                    following = len(text) if end == -1 else end + 1
                else:
                    break
            if following >= len(text) or text[following] not in '}]':
                output.append(char)
        else:
            output.append(char)
        if char == '\n':
            line_start = True
        elif not char.isspace():
            line_start = False
        index += 1
    return json.loads(''.join(output))


def load_config():
    return parse_config_text(CONFIG_PATH.read_text(encoding="utf-8"))


def load_sent():
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return data["sent"] if isinstance(data, dict) and isinstance(data.get("sent"), dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def save_sent(sent):
    temp = STATE_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps({"sent": sent}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, STATE_PATH)


def chat_value(value):
    text = str(value)
    return int(text) if re.fullmatch(r"-?\d+", text) else text


def occurrence(rule, now):
    """Return the current due occurrence; missed daily windows are not replayed."""
    if rule["repeat"] == "daily":
        return now.date().isoformat() if now.strftime("%H:%M") == rule["time"] else None
    scheduled = dt.datetime.strptime(rule["time"], "%Y-%m-%dT%H:%M").replace(tzinfo=CHINA_TIME)
    seconds = (now - scheduled).total_seconds()
    return rule["time"] if 0 <= seconds < 300 else None


async def main():
    try:
        from telethon import TelegramClient, events
    except ImportError as error:
        emit(f"缺少 Python 依赖：{error}。请安装 requirements.txt。", "error", "fatal")
        return 2

    config = load_config()
    rules = config.get("automations") or {}
    schedules = [rule for rule in rules.get("schedules", []) if rule.get("enabled", True)]
    forwards = [rule for rule in rules.get("forwards", []) if rule.get("enabled", True)]
    required = {rule["account"] for rule in schedules + forwards}
    users = {str(user.get("session") or user["name"]): user for user in config.get("telegram", {}).get("users", [])}
    clients = {}
    forward_tasks = []
    schedule_tasks = set()
    connected_clients = []
    sent = load_sent()
    in_flight = set()
    retry_after = {}

    try:
        for session in required:
            user = users.get(session)
            if not user:
                emit(f"账号 {session} 不存在，跳过其规则", "error")
                continue
            api_id, api_hash = resolve_credentials(config, user)
            client = TelegramClient(str(DATA_DIR / session), api_id, api_hash, device_model="AutoCheckin")
            connected_clients.append(client)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    emit(f"账号 {session} 尚未登录，请先在账号管理中完成登录", "error")
                    await client.disconnect()
                    connected_clients.remove(client)
                    continue
            except Exception as error:
                emit(f"账号 {session} 连接失败：{error}", "error")
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
            try:
                source = await client.get_input_entity(chat_value(rule["source"]))
                target = await client.get_input_entity(chat_value(rule["target"]))
            except Exception as error:
                emit(f"转发规则 {rule['source']} → {rule['target']} 无法解析会话：{error}", "error")
                continue

            queue = asyncio.Queue(maxsize=500)

            async def forward_loop(*, rule=rule, client=client, target=target, queue=queue):
                while True:
                    message = await queue.get()
                    try:
                        while True:
                            try:
                                await client.forward_messages(target, message)
                                emit(f"已转发 {rule['source']} 的新消息至 {rule['target']}")
                                break
                            except Exception as error:
                                wait = getattr(error, "seconds", None)
                                if isinstance(wait, int) and 0 < wait <= 3600:
                                    emit(f"转发触发 Telegram 限流，等待 {wait} 秒后重试", "error")
                                    await asyncio.sleep(wait + 1)
                                else:
                                    emit(f"转发 {rule['source']} → {rule['target']} 失败：{error}", "error")
                                    break
                    finally:
                        queue.task_done()

            async def forward_handler(event, *, rule=rule, queue=queue):
                try:
                    queue.put_nowait(event.message)
                except asyncio.QueueFull:
                    emit(f"转发队列已满，无法处理 {rule['source']} 的新消息", "error")

            client.add_event_handler(forward_handler, events.NewMessage(chats=source))
            forward_tasks.append(asyncio.create_task(forward_loop()))
            active_forwards += 1
            emit(f"正在监听 {rule['source']} → {rule['target']}")

        emit(f"自动化运行中：{len(schedules)} 条定时消息，{active_forwards} 条转发监听", kind="ready")

        async def send_schedule(rule, key):
            try:
                client = clients[rule["account"]]
                target = await client.get_input_entity(chat_value(rule["target"]))
                await client.send_message(target, rule["message"])
                sent[key] = dt.datetime.now(CHINA_TIME).isoformat(timespec="seconds")
                save_sent(sent)
                emit(f"定时消息已发送至 {rule['target']}")
            except Exception as error:
                wait = getattr(error, "seconds", None)
                retry_after[key] = time.monotonic() + (wait + 1 if isinstance(wait, int) and wait > 0 else 30)
                emit(f"定时消息发送至 {rule['target']} 失败：{error}", "error")
            finally:
                in_flight.discard(key)

        while True:
            now = dt.datetime.now(CHINA_TIME)
            for rule in schedules:
                if rule["account"] not in clients:
                    continue
                due = occurrence(rule, now)
                if not due:
                    continue
                key = f"{rule['id']}|{rule['time']}|{due}"
                if key in sent or key in in_flight or time.monotonic() < retry_after.get(key, 0):
                    continue
                in_flight.add(key)
                task = asyncio.create_task(send_schedule(rule, key))
                schedule_tasks.add(task)
                task.add_done_callback(schedule_tasks.discard)
            await asyncio.sleep(5)
    finally:
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


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        emit(f"自动化进程异常：{error}", "error", "fatal")
        sys.exit(2)
