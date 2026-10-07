"""Dependency stubs and network guard for offline Python regression tests."""
import os
import socket
import sys
import types
from network_guard import install_network_guard, deny_network
from pathlib import Path

TEMP_ROOT = Path(os.environ.get('AUTOCHECKIN_TEST_TMPDIR') or os.environ.get('TMPDIR') or __import__('tempfile').gettempdir()) / 'autocheckin-python-tests'
TEMP_ROOT.mkdir(parents=True, exist_ok=True)
os.environ['AUTOCHECKIN_DATA_DIR'] = str(TEMP_ROOT)


install_network_guard()


def install_stubs():
    telegram = types.ModuleType('telethon')
    telegram.TelegramClient = deny_network
    telegram.events = types.SimpleNamespace(NewMessage=lambda **kw: kw, MessageEdited=object())
    telegram.functions = types.SimpleNamespace(messages=types.SimpleNamespace(GetDialogFiltersRequest=lambda: None))
    errors = types.ModuleType('telethon.errors')
    errors.FloodWaitError = type('FloodWaitError', (Exception,), {})
    errors.SessionPasswordNeededError = type('SessionPasswordNeededError', (Exception,), {})
    ai = types.ModuleType('openai')
    ai.OpenAI = deny_network
    ocr = types.ModuleType('ddddocr')
    ocr.DdddOcr = lambda: types.SimpleNamespace(classification=deny_network)
    pil = types.ModuleType('PIL')
    pil.Image = pil.ImageFilter = pil.ImageEnhance = types.SimpleNamespace()
    sys.modules.update({'telethon': telegram, 'telethon.errors': errors, 'openai': ai, 'ddddocr': ocr, 'PIL': pil})


install_stubs()
