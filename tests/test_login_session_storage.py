"""Exercise the real Telethon SQLite Session without contacting Telegram."""
import asyncio
import contextlib
import gc
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import login_worker
from telethon.sessions import SQLiteSession
from network_guard import install_network_guard
install_network_guard()


class Client:
    def __init__(self, filename, *_args, **_kwargs):
        self.session = SQLiteSession(filename)

    async def connect(self):
        pass

    async def is_user_authorized(self):
        return True

    async def get_me(self):
        return None

    async def disconnect(self):
        self.session.close()


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.directory = Path(self.scratch.name)
        (self.directory / 'config.json').write_text(json.dumps({
            'telegram': {'users': [{'session': 'fresh', 'api_id': 123, 'api_hash': 'offline-only-private-hash'}]}
        }))
        self.session = self.directory / 'fresh.session'

    def tearDown(self):
        gc.collect()  # SQLiteSession constructors that raise may still hold their file.
        self.scratch.cleanup()

    async def run_login(self, factory=Client):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = await login_worker.login('fresh', self.directory, client_factory=factory)
        self.assertNotIn('offline-only-private-hash', output.getvalue())
        self.assertNotIn(str(self.directory), output.getvalue())
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        return code, events

    async def test_new_session_initializes_and_reopens_with_real_telethon(self):
        for _ in range(2):
            code, events = await self.run_login()
            self.assertEqual(code, 0)
            self.assertEqual(events[-1], {'type': 'success'})
        with closing(sqlite3.connect(self.session)) as database:
            self.assertEqual(database.execute('PRAGMA quick_check').fetchone(), ('ok',))
            self.assertEqual(database.execute('SELECT count(*) FROM version').fetchone(), (1,))
            columns = {row[1] for row in database.execute('PRAGMA table_info(sessions)')}
            self.assertIn('auth_key', columns)
        self.assertEqual(list(self.directory.glob('.session-write-check-*')), [])

    async def test_session_path_cannot_be_a_directory(self):
        self.session.mkdir()
        code, events = await self.run_login(lambda *_a, **_k: self.fail('must fail before constructing Telegram client'))
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'session_path')
        self.assertTrue(self.session.is_dir())

    async def test_directory_write_failure_is_not_reported_as_corruption(self):
        with patch.object(login_worker.tempfile, 'TemporaryFile', side_effect=PermissionError('private-path-must-not-be-shown')):
            code, events = await self.run_login(lambda *_a, **_k: self.fail('must not start Telegram'))
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'storage_permission')
        self.assertFalse(self.session.exists())

    async def test_invalid_database_is_preserved_and_identified(self):
        original = b'offline-invalid-database-not-credentials'
        self.session.write_bytes(original)
        code, events = await self.run_login()
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'session_corrupt')
        self.assertEqual(events[-1]['sqliteCode'], 'SQLITE_NOTADB')
        self.assertEqual(self.session.read_bytes(), original)

    async def test_real_readonly_sqlite_error_is_not_reported_as_corruption(self):
        await self.run_login()
        def readonly_factory(*_args, **_kwargs):
            with closing(sqlite3.connect(self.session.as_uri() + '?mode=ro', uri=True)) as database:
                database.execute('UPDATE version SET version = version')
            self.fail('SQLite must reject a write to a readonly connection')
        code, events = await self.run_login(readonly_factory)
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'storage_permission')
        self.assertEqual(events[-1]['sqliteCode'], 'SQLITE_READONLY')

    async def test_real_sqlite_cantopen_has_specific_code(self):
        def missing_parent_factory(*_args, **_kwargs):
            return Client(str(self.directory / 'missing-parent' / 'fresh'))
        code, events = await self.run_login(missing_parent_factory)
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'session_path')
        self.assertEqual(events[-1]['sqliteCode'], 'SQLITE_CANTOPEN')

    async def test_real_schema_failure_has_specific_code(self):
        await self.run_login()
        with closing(sqlite3.connect(self.session)) as database:
            database.execute('DROP TABLE sessions')
            database.commit()
        code, events = await self.run_login()
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'session_schema')
        self.assertEqual(events[-1]['sqliteCode'], 'SQLITE_ERROR')


if __name__ == '__main__':
    unittest.main()
