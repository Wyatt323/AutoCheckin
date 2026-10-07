"""Shared JSON document persistence; PostgreSQL when PGHOST/DATABASE_URL is set."""
import json
import os
from pathlib import Path


def database_enabled():
    return bool(os.environ.get('DATABASE_URL') or os.environ.get('PGHOST'))


def connect():
    import psycopg
    options = {'connect_timeout': 10, 'application_name': 'AutoCheckin worker'}
    if os.environ.get('DATABASE_URL'):
        return psycopg.connect(os.environ['DATABASE_URL'], **options)
    return psycopg.connect(**options)


def read_document(key, path=None, default=None, parser=json.loads):
    if database_enabled():
        with connect() as connection:
            row = connection.execute('SELECT value FROM autocheckin_documents WHERE key = %s', (key,)).fetchone()
            return row[0] if row else default
    if path is None:
        return default
    try:
        return parser(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def write_document(key, value, path=None):
    if database_enabled():
        from psycopg.types.json import Jsonb
        with connect() as connection:
            connection.execute('INSERT INTO autocheckin_documents (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', (key, Jsonb(value)))
        return
    target = Path(path)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as handle:
            os.chmod(temporary, 0o600)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
