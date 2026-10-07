"""Shared JSON document persistence; PostgreSQL when PGHOST/DATABASE_URL is set."""
import json
import os
from pathlib import Path


def parse_config_text(text):
    """Accept full-line # comments and trailing commas, never edit strings."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
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


def database_enabled():
    return bool(os.environ.get('DATABASE_URL') or os.environ.get('PGHOST'))


def connect():
    import psycopg
    options = {'connect_timeout': 10, 'application_name': 'AutoCheckin worker'}
    if os.environ.get('DATABASE_URL'):
        return psycopg.connect(os.environ['DATABASE_URL'], **options)
    return psycopg.connect(**options)


def read_document(key, path=None, default=None, parser=json.loads):
    key = os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX', '') + key
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
    key = os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX', '') + key
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
