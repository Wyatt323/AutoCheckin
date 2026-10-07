const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function createProfileStore(dataDir, store = null) {
  const cache = new Map();
  function read(account) {
    if (typeof account !== 'string' || !/^[\w.-]+$/.test(account) || ['.', '..'].includes(account)) return null;
    const file = path.join(dataDir, '.account-profiles', `${createHash('sha256').update(account).digest('hex')}.json`);
    try {
      const stored = store?.read(`profile:${createHash('sha256').update(account).digest('hex')}`);
      if (store && !stored) return null;
      const stat = store ? {size:0, mtimeMs:stored.updatedAt, ctimeMs:0} : fs.statSync(file);
      if (stat.size > 400000) return null;
      const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (cache.get(account)?.key === key) return cache.get(account).profile;
      const data = store ? stored : JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!/^\d{1,20}$/.test(data.userId) || !Number.isInteger(data.dcId) || data.dcId < 1 || data.dcId > 100) return null;
      const bytes = typeof data.avatar === 'string' && /^[A-Za-z0-9+/=]+$/.test(data.avatar) ? Buffer.from(data.avatar, 'base64') : null;
      const profile = {
        userId: data.userId, dcId: data.dcId, username: String(data.username || '').slice(0, 100),
        displayName: String(data.displayName || '').slice(0, 200), updatedAt: String(data.updatedAt || '').slice(0, 80),
        avatar: bytes?.length <= 256 * 1024 && bytes?.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? bytes : null,
      };
      cache.set(account, { key, profile });
      return profile;
    } catch { cache.delete(account); return null; }
  }
  function view(account) {
    const profile = read(account);
    if (!profile) return null;
    const { avatar, ...metadata } = profile;
    return { ...metadata, avatarUrl: avatar ? `/api/accounts/avatar?account=${encodeURIComponent(account)}&v=${encodeURIComponent(profile.updatedAt)}` : null };
  }
  return { read, view };
}
module.exports = { createProfileStore };
