'use strict';
const crypto = require('node:crypto');

// Server-only password, fixed-length comparison, opaque bounded sessions.
function createAdminAuth({ password = process.env.ADMIN_PASSWORD, ttlMs = 12 * 60 * 60 * 1000, now = Date.now, maxSessions = 256, maxIps = 2048 } = {}) {
  const configured = typeof password === 'string' && password.length > 0;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const expected = digest(configured ? password : crypto.randomBytes(32));
  const sessions = new Map(), failures = new Map();
  const windowMs = 15 * 60 * 1000;
  function cleanup() {
    const time = now();
    for (const [key, expires] of sessions) if (expires <= time) sessions.delete(key);
    for (const [key, entry] of failures) if (entry.until <= time) failures.delete(key);
  }
  function token(req) {
    const matches = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith('ac_session='));
    return matches.length === 1 ? matches[0].slice(11) : '';
  }
  function authenticated(req) {
    cleanup();
    return configured && sessions.has(token(req));
  }
  function cookie(value, secure, age) {
    return `ac_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  function login(req, input, secure) {
    cleanup();
    if (!configured) return { status: 503, error: '管理员密码尚未配置，请设置 ADMIN_PASSWORD 后重启服务。' };
    // Never trust X-Forwarded-For: remoteAddress is the trusted peer (proxy uses a shared limit).
    const ip = req.socket.remoteAddress || 'unknown';
    if ((failures.get(ip)?.count || 0) >= 10) return { status: 429, error: '尝试次数过多，请 15 分钟后重试。' };
    const value = typeof input.password === 'string' && input.password.length <= 4096 ? input.password : '';
    if (!value || !crypto.timingSafeEqual(digest(value), expected)) {
      if (!failures.has(ip) && failures.size >= maxIps) return { status: 429, error: '尝试次数过多，请稍后重试。' };
      const entry = failures.get(ip) || { count: 0, until: now() + windowMs };
      entry.count++; failures.set(ip, entry);
      return { status: 401, error: '管理密码不正确，请重试。' };
    }
    failures.delete(ip);
    sessions.delete(token(req));
    if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const valueToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(valueToken, now() + ttlMs);
    return { status: 200, cookie: cookie(valueToken, secure, Math.floor(ttlMs / 1000)) };
  }
  function logout(req, secure) {
    sessions.delete(token(req));
    return cookie('', secure, 0);
  }
  return { configured, authenticated, login, logout };
}
function requestSecurity(req, { publicHost, port, trustProxy = false }) {
  const host = `${publicHost}:${port}`;
  if (req.headers.host !== host) return { error: '访问地址不被允许' };
  const peer = req.socket.remoteAddress;
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const secure = !!req.socket.encrypted || (trustProxy && loopback && req.headers['x-forwarded-proto'] === 'https');
  const expectedOrigin = `${secure ? 'https' : 'http'}://${host}`;
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== expectedOrigin) return { error: '跨站请求被拒绝' };
  return { secure };
}
module.exports = { createAdminAuth, requestSecurity };
