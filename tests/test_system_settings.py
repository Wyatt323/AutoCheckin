import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import storage
from telegram_credentials import resolve_credentials


class SystemSettings(TestCase):
    def test_file_worker_effective_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tenant = root / 'tenant'
            tenant.mkdir()
            settings = {'telegram': {'api_id': 456, 'api_hash': 'global-hash'}, 'ai': {'model': 'system-model', 'providers': [{'api_key': 'system-key'}]}}
            original = {'telegram': {'api_id': 123, 'api_hash': 'own-hash', 'use_system': True}, 'ai': {'model': 'own-model', 'use_system': True}}
            (root / '.system-settings.json').write_text(json.dumps(settings), encoding='utf-8')
            (tenant / 'config.json').write_text(json.dumps(original), encoding='utf-8')
            with patch.dict(os.environ, {'DATABASE_URL': '', 'PGHOST': '', 'AUTOCHECKIN_SYSTEM_DATA_DIR': directory, 'AUTOCHECKIN_DOCUMENT_PREFIX': 'tenant:alice:'}):
                config = storage.read_document('config', tenant / 'config.json')
            self.assertEqual(resolve_credentials(config, {}), (456, 'global-hash'))
            self.assertEqual(resolve_credentials(config, {'api_id': 999, 'api_hash': 'account-hash'}), (999, 'account-hash'))
            self.assertEqual(config['ai']['model'], 'system-model')
            self.assertEqual(json.loads((tenant / 'config.json').read_text()), original)

    def test_database_system_is_unprefixed(self):
        config = {'telegram': {'use_system': True}, 'ai': {'use_system': True}}
        keys = []
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, sql, args):
                keys.append(args[0])
                return self
            def fetchone(self):
                return (config if keys[-1] == 'tenant:alice:config' else {'telegram': {'api_id': 123, 'api_hash': 'hash'}, 'ai': {'model': 'system', 'providers': []}},)
        with patch.dict(os.environ, {'DATABASE_URL': 'offline', 'AUTOCHECKIN_DOCUMENT_PREFIX': 'tenant:alice:'}), patch.object(storage, 'connect', return_value=Connection()):
            self.assertEqual(storage.read_document('config')['ai']['model'], 'system')
        self.assertEqual(keys, ['tenant:alice:config', 'system-settings'])


if __name__ == '__main__':
    main()
