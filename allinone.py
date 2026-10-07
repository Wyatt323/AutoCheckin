#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from telegram_credentials import resolve_credentials
from storage import read_document
import asyncio
import json
import random
import re
import os
import sys
import io
import contextlib
import datetime
from pathlib import Path
from telethon import TelegramClient, events, functions
from telethon.errors import FloodWaitError, SessionPasswordNeededError
from openai import OpenAI

try:
    import qrcode
except ImportError:
    qrcode = None

with open(os.devnull, 'w') as devnull, contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
    import ddddocr
    ocr = ddddocr.DdddOcr()

from PIL import Image, ImageFilter, ImageEnhance

# ========= 配置常量 =========
DATA_DIR = Path(os.environ.get("AUTOCHECKIN_DATA_DIR") or Path(__file__).resolve().parent)
# 单个 Bot 内部重试阈值：计数加 1 后达到此值即停止，设为 2 时最多追加重试 1 次。
MAX_RETRY = 2
# 批量签到总轮数上限（含首轮）；0 或 1 均只运行首轮，不再追加运行失败的 Bot。
# 达到上限且仍有失败时结束当前账号，继续处理后续用户账号。
MAX_FAILED_ROUNDS = 0
# 图片验证码的预期字符数，用于截取和校验 OCR 识别结果。
CAPTCHA_LENGTH = 4
# 相邻 Bot 之间随机等待时间的下限和上限，单位：秒。
BOT_INTERVAL_MIN = 5
BOT_INTERVAL_MAX = 15
# 等待签到按钮出现的最长时间，以及检查按钮的间隔，单位：秒。
SIGN_BUTTON_WAIT_SECONDS = 20
SIGN_BUTTON_POLL_SECONDS = 1
# 等待诗词答题按钮出现的最长时间，以及检查按钮的间隔，单位：秒。
POEM_BUTTON_WAIT_SECONDS = 15
POEM_BUTTON_POLL_SECONDS = 1


# ========= 工具函数 =========
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


def load_config(file_path=None):
    if file_path is None:
        file_path = DATA_DIR / "config.json"
    config = read_document('config', file_path, parser=parse_config_text)

    telegram = config["telegram"]
    ai = config["ai"]
    users = telegram.get("users") or config.get("users") or []
    legacy_bots = config.get("bots", [])
    legacy_bot_groups = config.get("bot_groups", {})
    legacy_dialog_folder = telegram.get("dialog_folder")

    ai_model = ai.get("model", "")
    ai_providers = ai.get("providers") or ([{"name": "default", "api_key": ai["api_key"], "base_url": ai["base_url"]}] if ai.get("api_key") and ai.get("base_url") else [])
    def parse_bots(bots, bot_groups):
        bot_list = []
        bot_commands = {}

        def add_bot(bot, command=None):
            if bot is None:
                return
            bot = str(bot).strip()
            if not bot:
                return
            if bot not in bot_list:
                bot_list.append(bot)
            if command:
                bot_commands[bot] = command

        for bot in bots:
            add_bot(bot)
        for bot in bot_groups.get("button", []):
            add_bot(bot)
        for item in bot_groups.get("command", []):
            if isinstance(item, str):
                add_bot(item, "/sign")
            else:
                command = item.get("command", "/sign")
                for bot in item.get("bots", []):
                    add_bot(bot, command)
                add_bot(item.get("bot"), command)
        return bot_list, bot_commands

    normalized_users = []
    for user in users:
        name = str(user.get("name", "")).strip()
        session = str(user.get("session", name)).strip() or name
        if not name:
            continue
        user_api_id, user_api_hash = resolve_credentials(config, user)
        has_own_bots = "bots" in user or "bot_groups" in user
        user_bots, user_commands = parse_bots(
            user.get("bots", []) if has_own_bots else legacy_bots,
            user.get("bot_groups", {}) if has_own_bots else legacy_bot_groups,
        )
        normalized_users.append({
            "name": name,
            "session": session,
            "api_id": user_api_id,
            "api_hash": user_api_hash,
            "bots": user_bots,
            "bot_commands": user_commands,
            "dialog_folder": user.get("dialog_folder", legacy_dialog_folder),
            "bot_schedules": user.get("bot_schedules", {}),
        })

    return ai_model, ai_providers, normalized_users


def build_ai_clients(ai_providers):
    clients = []
    for provider in ai_providers:
        provider = dict(provider)
        provider.setdefault("name", "unnamed")
        api_key = provider.get("api_key")
        base_url = provider.get("base_url")
        if api_key and base_url:
            clients.append((provider["name"], OpenAI(api_key=api_key, base_url=base_url, timeout=30, max_retries=1)))
    return clients


def normalize_captcha_code(code):
    return ''.join(filter(str.isalnum, code or ''))[:CAPTCHA_LENGTH]


def image_to_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def preprocess_captcha_variants(file_path):
    original = Image.open(file_path)
    gray = original.convert('L')
    variants = [image_to_bytes(original)]

    for contrast in (1.5, 2.0, 2.5):
        enhanced = ImageEnhance.Contrast(gray).enhance(contrast)
        variants.append(image_to_bytes(enhanced))
        variants.append(image_to_bytes(enhanced.resize((enhanced.width * 2, enhanced.height * 2))))
        for threshold in (120, 140, 160, 180):
            binary = enhanced.point(lambda x, t=threshold: 0 if x < t else 255)
            variants.append(image_to_bytes(binary))
            variants.append(image_to_bytes(binary.filter(ImageFilter.MedianFilter(3))))

    return variants


def recognize_captcha(file_path):
    candidates = []
    for img_bytes in preprocess_captcha_variants(file_path):
        try:
            code = normalize_captcha_code(ocr.classification(img_bytes))
        except Exception:
            continue
        if len(code) == CAPTCHA_LENGTH:
            candidates.append(code)

    if not candidates:
        return ''

    counts = {code: candidates.count(code) for code in set(candidates)}
    best, count = max(counts.items(), key=lambda item: item[1])
    print(f"  🔎 OCR候选: {', '.join(candidates[:8])}")
    if count >= 2 or len(counts) == 1:
        return best
    return ''


def poem_chars(text):
    return re.findall(r'[\u4e00-\u9fff░]', text or '')


def extract_poem_answers(poem_line, completed_text, blanks):
    masked = poem_chars(poem_line)
    completed = [c for c in poem_chars(completed_text) if c != '░']
    answers = []
    completed_idx = 0

    for ch in masked:
        if completed_idx >= len(completed):
            return None
        if ch == '░':
            answers.append(completed[completed_idx])
            completed_idx += 1
        elif ch == completed[completed_idx]:
            completed_idx += 1
        else:
            return None

    if len(answers) != blanks:
        return None
    return answers


def parse_ai_answers(result, poem_line, blanks, available_buttons=None):
    answers = extract_poem_answers(poem_line, result, blanks)
    if answers:
        return answers

    chars = re.findall(r'[\u4e00-\u9fff]', result or '')
    if available_buttons:
        chars = [c for c in chars if c in available_buttons]
    if len(chars) == blanks:
        return chars

    return None


def solve_poem_ai(text, ai_client, ai_model, available_buttons=None):
    poem_line = next((l.strip() for l in text.split('\n') if '░' in l), None)
    if not poem_line:
        return None
    blanks = poem_line.count('░')

    source_match = re.search(r'出自[：:]\s*(.+?)[。.\n]', text)
    source = source_match.group(1).strip() if source_match else "未知出处"

    if available_buttons:
        btn_str = "、".join(available_buttons)
        prompt = (
            f"请根据出处和残缺诗句检索/还原完整原诗句，再补全下方诗句中的空缺（每个 ░ 代表一个空缺，填入一个字）。\n\n"
            f"{poem_line}\n\n"
            f"出处：{source}\n\n"
            f"可用的按钮有：{btn_str}\n\n"
            f"必须先找到与残缺句完全匹配的完整诗句。"
            f"只输出完整诗句，不要解释，不要输出按钮列表。"
        )
    else:
        prompt = (
            f"请检索/还原完整原诗句，补全下方诗句中所有空缺（每个 ░ 代表一个空缺，填入一个字）：\n\n"
            f"{poem_line}\n\n"
            f"只输出完整诗句，不要解释。"
        )
    try:
        resp = ai_client.chat.completions.create(
            model=ai_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=100,
        )
        result = resp.choices[0].message.content.strip()
        print(f"  🧠 AI返回: {result}")
        answers = parse_ai_answers(result, poem_line, blanks, available_buttons)
        if not answers:
            return None
        return answers
    except Exception as e:
        print(f"  ❌ AI失败: {e}")
        return None


def solve_poem_ai_with_fallback(text, ai_clients, ai_model, available_buttons=None):
    for name, ai_client in ai_clients:
        print(f"  🧠 尝试AI中转站: {name}")
        answers = solve_poem_ai(text, ai_client, ai_model, available_buttons=available_buttons)
        if answers:
            return answers
    return None


def parse_result(text):
    t = text.replace(" ", "").replace("\n", "")
    if "已经签到" in t or "今日已签" in t:
        return "already"
    if "签到成功" in t or "签到完成" in t or "已完成签到" in t or "打卡成功" in t or re.search(r'\b(?:check.?in|sign.?in)\s*(?:successful|success)', t, re.I):
        return "success"
    if "验证码错误" in t:
        return "captcha_error"
    if "验证码" in t:
        return "captcha"
    return None


# ========= Bot签到器 =========
class BotSigner:
    def __init__(self, client, ai_clients, ai_model, bot, command=None):
        self.client = client
        self.ai_clients = ai_clients
        self.ai_model = ai_model
        self.bot = int(bot) if isinstance(bot, str) and bot.isdigit() else bot
        self.command = command
        self.retry = 0
        self.done = False
        self.active = False
        self.retrying = False
        self.verifying = False
        self.attempt_started_at = None
        self.result = None
        self.clicked_sign_button = False
        self.saw_response = False

    def is_success(self):
        return self.result in ("✅ 已签到", "🎉 签到成功")

    def reset_for_rerun(self):
        self.retry = 0
        self.done = False
        self.active = False
        self.retrying = False
        self.verifying = False
        self.attempt_started_at = None
        self.result = None

    async def click_sign(self):
        deadline = asyncio.get_running_loop().time() + SIGN_BUTTON_WAIT_SECONDS
        while asyncio.get_running_loop().time() < deadline:
            if self.done:
                return self.is_success()
            async for msg in self.client.iter_messages(self.bot, limit=10):
                if self.attempt_started_at and msg.date < self.attempt_started_at - datetime.timedelta(seconds=5):
                    continue
                if msg.buttons:
                    for row in msg.buttons:
                        for b in row:
                            if re.search(r'签到|每日签到|签一下|打卡|check.?in|sign.?in', b.text or '', re.I):
                                print(f"  👉 点击签到按钮: {b.text}")
                                click_result = await b.click()
                                self.clicked_sign_button = True
                                popup_text = getattr(click_result, "message", None)
                                if popup_text:
                                    print(f"  💬 弹窗: {popup_text}")
                                    res = parse_result(popup_text)
                                    if res == "already":
                                        print(f"  ✅ 弹窗显示今日已签到，跳过")
                                        self.result = "✅ 已签到"
                                        self.done = True
                                        return True
                                    if res == "success":
                                        print(f"  🎉 弹窗显示签到成功")
                                        self.result = "🎉 签到成功"
                                        self.done = True
                                        return True
                                return True
            await asyncio.sleep(SIGN_BUTTON_POLL_SECONDS)
        return False

    async def click_robot(self):
        async for msg in self.client.iter_messages(self.bot, limit=5):
            if self.attempt_started_at and msg.date < self.attempt_started_at - datetime.timedelta(seconds=5):
                continue
            if msg.buttons:
                for row in msg.buttons:
                    for b in row:
                        if "机器人" in (b.text or "").lower():
                            print(f"  🤖 点击机器人验证: {b.text}")
                            click_result = await b.click()
                            popup_text = getattr(click_result, "message", None)
                            if popup_text:
                                print(f"  💬 验证弹窗: {popup_text}")
                                res = parse_result(popup_text)
                                if res == "already":
                                    print(f"  ✅ 验证弹窗显示今日已签到，跳过")
                                    self.result = "✅ 已签到"
                                    self.done = True
                                    return True
                                if res == "success":
                                    print(f"  🎉 验证弹窗显示签到成功")
                                    self.result = "🎉 签到成功"
                                    self.done = True
                                    return True
                            await asyncio.sleep(2)
                            print(f"  ✅ 机器人验证完成，等待签到结果")
                            await self.check_recent_result()
                            return True
        return False

    async def handle_captcha(self, event):
        async for msg in self.client.iter_messages(self.bot, limit=2):
            if self.attempt_started_at and msg.date < self.attempt_started_at - datetime.timedelta(seconds=5):
                continue
            if msg.photo:
                # Keep downloaded captcha in memory; never leave images in cwd.
                data = await msg.download_media(file=bytes)
                if not data:
                    await self.retry_run()
                    return False
                code = await asyncio.to_thread(recognize_captcha, io.BytesIO(data))
                if self.done or not self.active:
                    return False
                print(f"  🧠 OCR验证码: {code}")
                if len(code) == CAPTCHA_LENGTH:
                    await event.respond(code)
                    print(f"  📨 已提交验证码")
                else:
                    await self.retry_run()
                return True
        return False

    async def check_recent_result(self):
        async for msg in self.client.iter_messages(self.bot, limit=5):
            if self.attempt_started_at and msg.date < self.attempt_started_at - datetime.timedelta(seconds=5):
                continue
            res = parse_result(msg.raw_text or '')
            if res == "already":
                print(f"  ✅ 最近消息显示已签到，停止重试")
                self.result = "✅ 已签到"
                self.done = True
                return True
            if res == "success":
                print(f"  🎉 最近消息显示签到成功，停止重试")
                self.result = "🎉 签到成功"
                self.done = True
                return True
        return False

    async def wait_poem_buttons(self, event):
        deadline = asyncio.get_running_loop().time() + POEM_BUTTON_WAIT_SECONDS
        while asyncio.get_running_loop().time() < deadline:
            message = event.message
            try:
                fresh = await self.client.get_messages(self.bot, ids=event.message.id)
                if fresh:
                    message = fresh
            except Exception:
                pass

            if message.buttons:
                btn_map = {}
                for row in message.buttons:
                    for b in row:
                        btn_map[b.text] = b
                return btn_map

            await asyncio.sleep(POEM_BUTTON_POLL_SECONDS)

        return {}

    async def handle_poem(self, event, text):
        if self.verifying:
            return
        self.verifying = True
        try:
            btn_map = await self.wait_poem_buttons(event)
            if not btn_map:
                print(f"  ❌ 诗词按钮等待超时")
                await self.retry_run()
                return

            available = list(btn_map.keys())
            print(f"  🤖 AI解析诗句 (可用按钮: {', '.join(available)})")
            answers = await asyncio.to_thread(
                solve_poem_ai_with_fallback, text, self.ai_clients, self.ai_model,
                available_buttons=available,
            )
            if self.done or not self.active:
                return
            if not answers:
                print(f"  ❌ AI未能解析诗句")
                await self.retry_run()
                return

            blanks = text.count('░')
            print(f"  ✅ AI答案: {' '.join(answers)} (空缺{blanks}个)")
            if len(answers) != blanks:
                print(f"  ❌ AI答案数量不匹配")
                await self.retry_run()
                return

            for idx, ch in enumerate(answers):
                await asyncio.sleep(1.5)
                if self.done or not self.active:
                    return
                try:
                    fresh = await self.client.get_messages(self.bot, ids=event.message.id)
                    if fresh and fresh.buttons:
                        btn_map = {}
                        for row in fresh.buttons:
                            for b in row:
                                btn_map[b.text] = b
                except Exception:
                    pass

                if ch not in btn_map:
                    print(f"  ❌ 找不到按钮 '{ch}'")
                    await self.retry_run()
                    return

                print(f"  👉 [{idx+1}/{len(answers)}] 点击: {ch}")
                try:
                    await btn_map[ch].click()
                except Exception as e:
                    print(f"  ❌ 点击失败: {e}")
                    await self.retry_run()
                    return

            print(f"  ✅ 诗词验证完成")
        finally:
            self.verifying = False

    async def retry_run(self):
        if self.done or self.retrying:
            return
        self.retrying = True
        self.retry += 1
        self.verifying = False
        if self.retry >= MAX_RETRY:
            print(f"  ❌ 超过最大重试次数")
            self.result = "❌ 失败"
            self.done = True
            self.retrying = False
            return
        print(f"  🔁 重试 {self.retry}/{MAX_RETRY}")
        try:
            await asyncio.sleep(random.uniform(1, 3))
            if self.done or not self.active or await self.check_recent_result():
                return
            await self.start()
        finally:
            self.retrying = False

    async def start(self):
        print(f"\n🚀 开始处理 {self.bot}")
        self.active = True
        self.attempt_started_at = datetime.datetime.now(datetime.timezone.utc)
        if self.command:
            print(f"  📨 发送签到命令: {self.command}")
            await self.client.send_message(self.bot, self.command)
            return

        await self.client.send_message(self.bot, "/start")
        clicked = await self.click_sign()
        if not clicked:
            print(f"  ⚠️ 未找到签到按钮")


# ========= 主程序 =========
async def run_signer_once(signer, bot, timeout=120):
    try:
        await signer.start()

        for _ in range(timeout):
            if signer.done:
                break
            await asyncio.sleep(1)

        if not signer.done:
            print(f"  ⏰ 超时未完成")
            signer.result = "⏰ 超时"
            signer.done = True

        return signer.is_success()
    except Exception as error:
        print(f"  ❌ {bot} 签到失败: {error}")
        signer.result = "❌ 失败"
        signer.done = True
        return False
    finally:
        signer.active = False


async def resolve_dialog_filter(client, folder_name):
    """Custom chat folders are dialog filters, not GetDialogs archive folder IDs."""
    if folder_name is None or str(folder_name).strip() == "":
        return None
    folder_name = str(folder_name).strip()
    if folder_name in ('0', '1'):
        return {'builtin':int(folder_name)}
    response = await client(functions.messages.GetDialogFiltersRequest())
    for dialog_filter in getattr(response, 'filters', response):
        title = getattr(dialog_filter, "title", None)
        title = getattr(title, "text", title)
        if (folder_name.isdigit() and getattr(dialog_filter, 'id', None) == int(folder_name)) or (isinstance(title, str) and title.strip() == folder_name):
            return dialog_filter
    return None


async def resolve_dialog_folder(client, folder_name):
    if folder_name is not None and str(folder_name).strip().isdigit():
        return int(str(folder_name).strip())
    dialog_filter = await resolve_dialog_filter(client, folder_name)
    return dialog_filter.get('builtin') if isinstance(dialog_filter, dict) else getattr(dialog_filter, 'id', None)


def dialog_in_filter(dialog, dialog_filter):
    if isinstance(dialog_filter, dict):
        return True  # Built-in main/archive filtering is handled by iter_dialogs.
    entity = dialog.entity
    peer_id = getattr(entity, 'id', None)
    def ids(peers):
        return {getattr(peer, 'user_id', getattr(peer, 'chat_id', getattr(peer, 'channel_id', None))) for peer in peers or []}
    if peer_id in ids(getattr(dialog_filter, 'exclude_peers', [])):
        return False
    included = ids(getattr(dialog_filter, 'include_peers', [])) | ids(getattr(dialog_filter, 'pinned_peers', []))
    if peer_id in included:
        return True
    if not getattr(dialog_filter, 'bots', False):
        return False
    if getattr(dialog_filter, 'exclude_archived', False) and getattr(dialog, 'archived', False):
        return False
    if getattr(dialog_filter, 'exclude_read', False) and not getattr(dialog, 'unread_count', 0):
        return False
    if getattr(dialog_filter, 'exclude_muted', False):
        settings = getattr(getattr(dialog, 'dialog', None), 'notify_settings', None)
        until = getattr(settings, 'mute_until', None)
        if until and until > datetime.datetime.now(datetime.timezone.utc):
            return False
    return True


async def get_account_bots(client, bots, dialog_folder=None):
    """A selected folder is authoritative; never fall back to configured bots."""
    requested = {bot.lower().lstrip("@"): bot for bot in bots}
    available = set()
    dialog_filter = await resolve_dialog_filter(client, dialog_folder) if dialog_folder else None
    if dialog_folder and dialog_filter is None:
        raise ValueError(f"找不到 Telegram 分组: {dialog_folder}")

    try:
        folder_id = dialog_filter.get('builtin') if isinstance(dialog_filter, dict) else None
        async for dialog in client.iter_dialogs(folder=folder_id):
            entity = dialog.entity
            username = (getattr(entity, "username", None) or "").lower()
            if dialog_folder:
                if getattr(entity, 'bot', False) and dialog_in_filter(dialog, dialog_filter):
                    available.add('@' + username if username else str(entity.id))
            elif username in requested:
                available.add(requested[username])
    except Exception as e:
        if dialog_folder:
            raise RuntimeError('读取指定分组失败，已停止分组签到') from e
        print(f"⚠️ 读取账号对话列表失败，将跳过 Bot 筛选: {e}")
        return list(bots)

    if dialog_folder:
        return sorted(available)

    for bot in bots:
        if bot not in available:
            print(f"⏭️ 当前账号没有 {bot}，跳过")
    return [bot for bot in bots if bot in available]


async def get_bot_display_name(client, bot):
    try:
        entity = await client.get_entity(int(bot) if isinstance(bot, str) and bot.isdigit() else bot)
        name = " ".join(
            part for part in (
                getattr(entity, "first_name", None),
                getattr(entity, "last_name", None),
            ) if part
        ).strip()
        return name or getattr(entity, "title", None) or bot
    except Exception:
        return bot


async def mark_all_read(client, bots):
    print("\n📨 标记已读...")
    for bot in bots:
        try:
            await client.send_read_acknowledge(int(bot) if isinstance(bot, str) and bot.isdigit() else bot)
        except Exception as e:
            print(f"  ⚠️ {bot} 标记已读失败: {e}")


def install_handlers(client, signers):
    @client.on(events.NewMessage)
    @client.on(events.MessageEdited)
    async def handler(event):
        sender = await event.get_sender()
        if not sender:
            return
        username = getattr(sender, "username", None)
        username = username or ''
        bot = next((key for key in signers if key.lstrip("@").lower() == username.lower()), None)
        if bot is None:
            bot = next((key for key in signers if key == str(getattr(sender, 'id', ''))), None)
        if bot is None:
            return
        signer = signers[bot]
        if signer.done or not signer.active:
            return

        message_date = getattr(event.message, "date", None)
        if signer.attempt_started_at and message_date and message_date < signer.attempt_started_at - datetime.timedelta(seconds=5):
            return
        text = event.raw_text or ""
        signer.saw_response = True
        print(f"{bot} 📩 {text[:120]}")

        if "░" in text:
            await signer.handle_poem(event, text)
            return

        res = parse_result(text)

        if res == "already":
            print(f"  ✅ 已签到")
            signer.result = "✅ 已签到"
            signer.done = True
            return

        if res == "success":
            print(f"  🎉 签到成功")
            signer.result = "🎉 签到成功"
            signer.done = True
            return

        if res == "captcha_error":
            print(f"  ❌ 验证码错误")
            await signer.retry_run()
            return

        if res == "captcha":
            print(f"  🧠 检测到验证码")
            await signer.handle_captcha(event)
            return

        await signer.click_robot()


async def login_by_qr(client):
    print("\\n📱 当前 session 未登录，准备使用 Telegram 扫码登录")
    while True:
        qr_login = await client.qr_login()
        print("\\n请使用已登录的 Telegram 客户端扫描二维码：")
        if qrcode is not None:
            qr = qrcode.QRCode(border=1)
            qr.add_data(qr_login.url)
            qr.make(fit=True)
            qr.print_ascii(invert=True)
        else:
            print("当前环境未安装 qrcode，无法显示二维码。请打开以下 tg:// URL 生成二维码：")
            print(qr_login.url)
        try:
            await qr_login.wait()
            print("✅ Telegram 扫码登录成功")
            return
        except asyncio.TimeoutError:
            print("⚠️ 二维码已过期，正在生成新的二维码...")
        except SessionPasswordNeededError:
            password = input("请输入 Telegram 两步验证密码：")
            await client.sign_in(password=password)
            print("✅ Telegram 扫码登录成功")
            return


async def run_user(user, ai_model, ai_clients, bots, bot_commands, dialog_folder=None, only_bot=None):
    session_name = user["session"]
    user_name = user["name"]
    api_id = user["api_id"]
    api_hash = user["api_hash"]
    client = TelegramClient(
        str(DATA_DIR / session_name),
        api_id,
        api_hash,
        device_model="AutoCheckin",
    )
    signers = {}
    install_handlers(client, signers)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            try:
                await login_by_qr(client)
            except FloodWaitError as e:
                print(f"❌ Telegram 暂时禁止登录，还需等待 {e.seconds} 秒（约 {e.seconds / 3600:.1f} 小时）")
                return False
        account_bots = await get_account_bots(client, bots, dialog_folder)
        if only_bot is not None:
            account_bots = [bot for bot in account_bots if bot.lower() == only_bot.lower()]
        elif not dialog_folder:
            # Independent schedules own these bots, including during manual batch runs.
            independent = {bot.lower() for bot, rule in user.get('bot_schedules', {}).items() if rule.get('enabled')}
            account_bots = [bot for bot in account_bots if bot.lower() not in independent]
        signers.update({bot: BotSigner(client, ai_clients, ai_model, bot, bot_commands.get(bot)) for bot in account_bots})
        print(f"\n====== 👤 开始用户 {user_name} ({session_name}) ======")
        print(f"配置 {len(bots)} 个Bot，当前账号可签到 {len(account_bots)} 个Bot")
        if not account_bots:
            print("⏭️ 当前账号没有可签到的Bot，跳过本用户")
            return True

        active_bots = account_bots
        pending_bots = list(active_bots)
        round_no = 1
        stopped_by_limit = False

        while pending_bots:
            print(f"\n====== 🔄 第 {round_no} 轮签到，待处理 {len(pending_bots)} 个Bot ======")
            failed_bots = []

            for i, bot in enumerate(pending_bots):
                signer = signers[bot]
                if round_no > 1:
                    signer.reset_for_rerun()

                if dialog_folder:
                    from bot_discovery import run_discovered_bot
                    success = await run_discovered_bot(signer, bot, session_name, DATA_DIR, run_signer_once)
                else:
                    success = await run_signer_once(signer, bot)
                if not success:
                    failed_bots.append(bot)

                if i < len(pending_bots) - 1:
                    delay = random.randint(BOT_INTERVAL_MIN, BOT_INTERVAL_MAX)
                    print(f"⏳ 等待 {delay}s 后处理下一个Bot...")
                    await asyncio.sleep(delay)

            if failed_bots:
                print(f"\n⚠️ 本轮未成功Bot: {', '.join(failed_bots)}")
                if round_no >= MAX_FAILED_ROUNDS:
                    print(f"❌ 已重试 {MAX_FAILED_ROUNDS} 轮仍未成功，结束当前账号")
                    for bot in failed_bots:
                        signers[bot].result = signers[bot].result or "❌ 重试失败"
                    stopped_by_limit = True
                    break
                print(f"🔁 将再次运行未成功的Bot，最多重试 {MAX_FAILED_ROUNDS} 轮")

            pending_bots = failed_bots
            round_no += 1

        print("\n====== 📊 签到结果汇总 ======")
        for bot in active_bots:
            display_name = await get_bot_display_name(client, bot)
            print(f"  {display_name} -> {signers[bot].result or '⚠️ 未知'}")
        return not stopped_by_limit
    finally:
        try:
            await mark_all_read(client, signers.keys())
        finally:
            await client.disconnect()
        print(f"🛑 用户 {user_name} 结束")


async def main(account=None, bot=None):
    ai_model, ai_providers, users = load_config()
    if account is not None:
        users = [user for user in users if user['session'] == account]
        if not users:
            raise ValueError(f'找不到 Session 为 {account} 的账号')
    ai_clients = build_ai_clients(ai_providers)
    if not ai_clients:
        print('未配置 AI；普通签到可执行，诗词验证码将无法自动作答')

    print("====== 🤖 开始批量签到 ======")
    print(f"共 {len(users)} 个用户, {sum(len(user['bots']) for user in users)} 个账号-Bot 配置")

    previous_executed = False
    failed_any = False
    for user in users:
        bots = user["bots"]
        if not bots and not user['dialog_folder']:
            print(f"⏭️ 用户 {user['name']} 没有配置 Bot，跳过")
            continue
        if previous_executed:
            delay = random.randint(BOT_INTERVAL_MIN, BOT_INTERVAL_MAX)
            print(f'⏳ 等待 {delay}s 后处理下一个账号的 Bot...')
            await asyncio.sleep(delay)
        previous_executed = True
        if bot is None:
            completed = await run_user(user, ai_model, ai_clients, bots, user["bot_commands"], user["dialog_folder"])
        else:
            completed = await run_user(user, ai_model, ai_clients, bots, user["bot_commands"], user["dialog_folder"], only_bot=bot)
        if not completed:
            failed_any = True
            print(f"⚠️ 用户 {user['name']} 有未完成的 Bot，继续处理下一个账号")
    return not failed_any


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='AutoCheckin Telegram 签到')
    parser.add_argument('--account', help='仅运行指定 Session 的账号')
    parser.add_argument('--bot', help='仅运行指定 Bot，必须同时指定 --account')
    args = parser.parse_args()
    if args.bot and not args.account:
        parser.error('--bot requires --account')
    sys.exit(0 if asyncio.run(main(args.account, args.bot)) else 1)
