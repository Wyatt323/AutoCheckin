import sys
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import storage


class Connection:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, sql, args):
        self.calls.append((sql, args))
        return self

    def fetchone(self):
        return ({'owner': 'alice'},)


class TenantStorage(TestCase):
    def test_node_worker_document_prefix(self):
        connection = Connection()
        with patch.dict(storage.os.environ, {'DATABASE_URL': 'offline', 'AUTOCHECKIN_DOCUMENT_PREFIX': 'tenant:alice:'}), patch.object(storage, 'connect', return_value=connection):
            self.assertEqual(storage.read_document('config')['owner'], 'alice')
            storage.write_document('automation-state', {'sent': {}})
        self.assertEqual(connection.calls[0][1], ('tenant:alice:config',))
        self.assertEqual(connection.calls[1][1][0], 'tenant:alice:automation-state')


if __name__ == '__main__':
    main()
