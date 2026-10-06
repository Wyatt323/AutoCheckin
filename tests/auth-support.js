// Explicit offline password and authenticated fetch for existing server fixtures.
const PASSWORD = 'offline-admin-test-only';
process.env.ADMIN_PASSWORD = PASSWORD;
const rawFetch = global.fetch;
const cookies = new Map();
global.fetch = async (url, options = {}) => {
  const base = new URL(url).origin;
  if (!cookies.has(base)) {
    const response = await rawFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    if (!response.ok) throw new Error(`Offline fixture auth failed: ${response.status}`);
    cookies.set(base, response.headers.get('set-cookie').split(';')[0]);
  }
  return rawFetch(url, { ...options, headers: { ...(options.headers || {}), Cookie: cookies.get(base) } });
};
async function authenticatePage(page, base) {
  await global.fetch(base + '/api/auth/status');
  await page.context().addCookies([{ name: 'ac_session', value: cookies.get(base).slice(11), url: base, httpOnly: true, sameSite: 'Strict' }]);
}
module.exports = { authenticatePage, resetAuth: base => cookies.delete(base) };
