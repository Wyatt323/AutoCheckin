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


def read_document(key, path=None, default=None, parser=json.loads, system=False):
    document_key = key
    key = ('' if system else os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX', '')) + key
    if database_enabled():
        with connect() as connection:
            row = connection.execute('SELECT value FROM autocheckin_documents WHERE key = %s', (key,)).fetchone()
            value = row[0] if row else default
    elif path is None:
        value = default
    else:
        try:
            value = parser(Path(path).read_text(encoding='utf-8'))
        except FileNotFoundError:
            value = default
    if document_key == 'config' and value:
        system_dir = os.environ.get('AUTOCHECKIN_SYSTEM_DATA_DIR') or os.environ.get('AUTOCHECKIN_DATA_DIR') or (str(Path(path).parent) if path else '.')
        settings = read_effective_settings(system_dir, str(Path(path).parent) if path else None)
        return apply_system_config(value, settings)
    return value


def read_effective_settings(system_dir=None, user_dir=None):
    from copy import deepcopy
    root = Path(system_dir or os.environ.get('AUTOCHECKIN_SYSTEM_DATA_DIR') or os.environ.get('AUTOCHECKIN_DATA_DIR') or Path(__file__).resolve().parent)
    def normalize(settings):
        settings = deepcopy(settings)
        proxy = settings.get('proxy', {})
        settings.setdefault('proxies', [{**proxy, 'enabled': True, 'id': 'legacy-proxy'}] if proxy.get('host') else [])
        settings.setdefault('default_proxy_id', 'legacy-proxy' if proxy.get('enabled') else '')
        for index, provider in enumerate(settings.get('ai', {}).get('providers', [])):
            provider.setdefault('id', f'legacy-ai-{index}')
        return settings
    admin = normalize(read_document('system-settings', root / '.system-settings.json', default={}, system=True))
    tenant = bool(os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX'))
    directory = Path(user_dir or os.environ.get('AUTOCHECKIN_DATA_DIR') or '.')
    own = normalize(read_document('system-settings', directory / '.system-settings.json', default={}) if tenant else
                    read_document('personal-settings', root / '.personal-settings.json', default={}, system=True))
    telegram_own = bool(own.get('telegram', {}).get('api_id') and own.get('telegram', {}).get('api_hash'))
    ai_own = bool(own.get('ai', {}).get('providers'))
    proxy_owner = own if own.get('default_proxy_id') else admin
    return {**admin, 'automatic': tenant, 'overrides': {'telegram': telegram_own or own.get('use_globals') is True, 'ai': ai_own or own.get('use_globals') is True},
            'telegram': deepcopy((own if telegram_own else admin).get('telegram', {})),
            'ai': deepcopy((own if ai_own else admin).get('ai', {'providers': []})),
            'available_providers': [{**p, 'model': p.get('model') or source.get('ai', {}).get('model', '')}
                                    for source in (own, admin) for p in source.get('ai', {}).get('providers', [])],
            'proxies': own['proxies'] + admin['proxies'],
            'default_proxy_id': proxy_owner.get('default_proxy_id', ''),
            'proxy': deepcopy(proxy_owner.get('proxy', {'enabled': False}))}


def apply_system_config(config, settings):
    from copy import deepcopy
    config = deepcopy(config)
    if settings.get('automatic') or settings.get('overrides', {}).get('telegram') or config.get('telegram', {}).get('use_system') is True:
        config.setdefault('telegram', {}).update(api_id=settings.get('telegram', {}).get('api_id', ''), api_hash=settings.get('telegram', {}).get('api_hash', ''))
    if settings.get('automatic') or settings.get('overrides', {}).get('ai') or config.get('ai', {}).get('use_system') is True:
        selected = None if config.get('ai', {}).get('use_system') is False else config.get('ai', {}).get('system_provider_id')
        config['ai'] = {**deepcopy(settings.get('ai', {'providers': []})), 'use_system': True}
        if selected:
            config['ai']['providers'] = [item for index, item in enumerate(settings.get('available_providers', config['ai'].get('providers', [])))
                                         if (item.get('id') or f'legacy-ai-{index}') == selected]
    return config


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
