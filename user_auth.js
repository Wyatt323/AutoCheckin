'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { createAdminAuth } = require('./admin_auth');
const scrypt = promisify(crypto.scrypt);
const DEFAULT_PASSWORD = 'a123456';

async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash:(await scrypt(password, salt, 64)).toString('hex') };
}
async function matches(password, record) {
  if (typeof password !== 'string' || password.length > 4096) return false;
  const hash = Buffer.from((await passwordHash(password, record.salt)).hash, 'hex');
  const expected = Buffer.from(record.hash, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}
const publicUser = user => ({id:user.id, username:user.username, role:'user', mustChangePassword:user.mustChangePassword, createdAt:user.createdAt});

async function createUserAuth({dataDir, store = null, password = process.env.ADMIN_PASSWORD, adminUsername = process.env.ADMIN_USERNAME || 'admin', now = Date.now} = {}) {
  const admin = createAdminAuth({password, now});
  const administrator = {id:'admin', username:adminUsername, role:'admin', mustChangePassword:false};
  const file = path.join(dataDir, '.web-users.json');
  let users = store ? structuredClone(store.read('web-users') || []) : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
  if (!Array.isArray(users)) throw new Error('网页用户数据格式错误');
  if (users.some(user=>!user || !/^[a-f0-9-]{36}$/.test(user.id) || typeof user.username !== 'string' || user.username.toLowerCase() === adminUsername.toLowerCase())) throw new Error('网页用户标识无效或管理员用户名冲突');
  const sessions = new Map(), failures = new Map();
  let queue = Promise.resolve();
  function mutate(operation) {
    const result = queue.then(async () => {
      const next = structuredClone(users);
      const result = await operation(next);
      if (store) await store.write('web-users',next);
      else { fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600}); fs.renameSync(file+'.tmp',file); }
      users = next;
      return result;
    });
    queue = result.catch(()=>{});
    return result;
  }
  function token(req) {
    const values = (req.headers.cookie || '').split(';').map(s=>s.trim()).filter(s=>s.startsWith('ac_session='));
    return values.length === 1 ? values[0].slice(11) : '';
  }
  function cleanup() {
    for (const [key,session] of sessions) if (session.expires <= now()) sessions.delete(key);
    for (const [key,entry] of failures) if (entry.until <= now()) failures.delete(key);
  }
  function identity(req) {
    cleanup();
    if (admin.authenticated(req)) return administrator;
    const session = sessions.get(token(req));
    const user = session && users.find(user=>user.id === session.id && user.version === session.version);
    return user ? publicUser(user) : null;
  }
  function cookie(value,secure,age) { return `ac_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`; }
  return {
    configured:admin.configured,
    identity,
    list:()=>users.map(publicUser),
    async login(req,input,secure) {
      const username = typeof input.username === 'string' ? input.username.trim() : adminUsername;
      if (username.toLowerCase() === adminUsername.toLowerCase()) {
        const result = admin.login(req,input,secure);
        sessions.delete(token(req));
        return {...result,user:result.status === 200 ? administrator : undefined};
      }
      cleanup();
      const ip = req.socket.remoteAddress || 'unknown';
      if ((failures.get(ip)?.count || 0) >= 10 || (!failures.has(ip) && failures.size >= 2048)) return {status:429,error:'尝试次数过多，请 15 分钟后重试。'};
      const user = users.find(user=>user.username.toLowerCase() === username.toLowerCase());
      // Perform the same expensive check for unknown usernames.
      const valid = await matches(input.password, user || {salt:'unknown-user',hash:'00'.repeat(64)});
      if (!user || !valid) {
        const entry = failures.get(ip) || {count:0,until:now()+900000}; entry.count++; failures.set(ip,entry);
        return {status:401,error:'用户名或密码不正确，请重试。'};
      }
      failures.delete(ip);
      admin.logout(req,secure); sessions.delete(token(req));
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      const value = crypto.randomBytes(32).toString('base64url');
      sessions.set(value,{id:user.id,version:user.version,expires:now()+43200000});
      return {status:200,cookie:cookie(value,secure,43200),user:publicUser(user)};
    },
    logout(req,secure) { sessions.delete(token(req)); admin.logout(req,secure); return cookie('',secure,0); },
    async add(username) {
      if (typeof username !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,31}$/.test(username)) throw new Error('用户名须为 3–32 位字母、数字、下划线、点或短横线');
      return mutate(async next => {
        if (username.toLowerCase() === adminUsername.toLowerCase() || next.some(user=>user.username.toLowerCase() === username.toLowerCase())) throw new Error('用户名已存在');
        if (next.length >= 100) throw new Error('网页用户数量已达上限');
        const user = {id:crypto.randomUUID(),username,...await passwordHash(DEFAULT_PASSWORD),mustChangePassword:true,version:1,createdAt:new Date(now()).toISOString()};
        next.push(user); return publicUser(user);
      });
    },
    async changePassword(req,input) {
      const current = identity(req);
      if (!current || current.role !== 'user') throw new Error('请先使用用户账号登录');
      const password = input.newPassword;
      if (typeof password !== 'string' || password.length < 8 || password.length > 128 || password === DEFAULT_PASSWORD) throw new Error('新密码须为 8–128 位，且不能使用默认密码');
      const changed = await mutate(async next => {
        const user = next.find(user=>user.id === current.id);
        if (!await matches(input.currentPassword,user)) throw new Error('原密码不正确');
        if (await matches(password,user)) throw new Error('新密码不能与原密码相同');
        Object.assign(user,await passwordHash(password),{mustChangePassword:false,version:user.version+1});
        return publicUser(user);
      });
      // Other browser sessions are invalidated; this session keeps its expiry.
      const session = sessions.get(token(req));
      if (session) session.version = users.find(user=>user.id === changed.id).version;
      return changed;
    }
  };
}
module.exports = {createUserAuth};
