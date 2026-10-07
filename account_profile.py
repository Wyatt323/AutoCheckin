"""Cache only Telegram display data, separately from credentials/configuration."""
import asyncio
import base64
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from storage import read_document, write_document


async def save_profile(client, account, data_dir):
    me = await asyncio.wait_for(client.get_me(), 15)
    if not me:
        raise ValueError('No authorized user')
    folder = Path(data_dir) / '.account-profiles'
    target = folder / (hashlib.sha256(account.encode('utf-8')).hexdigest() + '.json')
    profile = {
        'userId': str(me.id), 'dcId': client.session.dc_id,
        'username': me.username or '',
        'displayName': ' '.join(filter(None, [me.first_name, me.last_name])),
        'updatedAt': datetime.now(timezone.utc).isoformat(), 'avatar': None,
    }
    try:
        avatar = await asyncio.wait_for(client.download_profile_photo(me, file=bytes, download_big=False), 20)
        if avatar and len(avatar) <= 256 * 1024 and avatar.startswith(b'\xff\xd8\xff'):
            profile['avatar'] = base64.b64encode(avatar).decode('ascii')
    except Exception:
        # A failed photo download must not hide ID/DC or discard a cached photo.
        try:
            previous = read_document('profile:' + target.stem, target, default={})
            if previous.get('userId') == profile['userId']:
                profile['avatar'] = previous.get('avatar')
        except (OSError, ValueError):
            pass
    write_document('profile:' + target.stem, profile, target)
    return profile
