const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { createProfileStore } = require('../account_profiles');
const { createLoginController } = require('../login');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-profile-'));
  let server;
  try {
    fs.mkdirSync(path.join(root, '.account-profiles'));
    const file = path.join(root, '.account-profiles', createHash('sha256').update('offline').digest('hex') + '.json');
    const avatar = Buffer.from([255, 216, 255, 1, 2, 3]);
    fs.writeFileSync(file, JSON.stringify({ userId:'123456789012', dcId:2, username:'offline_user', updatedAt:'2026-10-07T00:00:00Z', avatar:avatar.toString('base64'), phone:'not-for-display' }));
    const store = createProfileStore(root);
    assert.equal(store.view('offline').userId, '123456789012');
    assert.equal(store.view('offline').dcId, 2);
    assert.ok(store.view('offline').avatarUrl.startsWith('/api/accounts/avatar?'));
    assert.equal(store.view('offline').phone, undefined);
    assert.equal(store.view('offline').avatar, undefined);
    assert.equal(store.read('../bad'), null);
    assert.deepEqual(store.read('offline').avatar, avatar);
    let child, resumed = 0;
    const login = createLoginController({ root, dataDir:root, readConfig:() => ({telegram:{users:[{session:'offline', api_id:123, api_hash:'private-hash'}]}}), pythonCommand:() => ({name:'python', prefix:[]}), isBusy:() => false, stopAutomation:async () => {}, resumeAutomation:() => resumed++, spawnWorker:(_name, args) => {
      assert.ok(args.includes('--profile-only'));
      child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      return child;
    } });
    await assert.rejects(login.start('offline', {profileOnly:true}), /先登录/);
    fs.writeFileSync(path.join(root, 'offline.session'), 'offline-placeholder');
    const state = await login.start('offline', {profileOnly:true});
    assert.equal(state.mode, 'profile');
    await assert.rejects(login.start('offline'), /任务正在运行/);
    child.stdout.write('{"type":"success"}\n'); child.emit('close', 0);
    assert.equal(login.status().active, false); assert.equal(resumed, 1);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({telegram:{users:[{session:'offline', name:'Offline', api_id:123, api_hash:'private-hash', bots:[]}]}, ai:{providers:[]}}));
    const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env:{...process.env, AUTOCHECKIN_DATA_DIR:root, PORT:String(port), PUBLIC_HOST:'127.0.0.1', ADMIN_PASSWORD:'offline-profile-test'}, stdio:'ignore' });
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const url = base + store.view('offline').avatarUrl;
    assert.equal((await fetch(url)).status, 401);
    const auth = await fetch(base + '/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:'offline-profile-test'})});
    const Cookie = auth.headers.get('set-cookie').split(';')[0];
    const response = await fetch(url, {headers:{Cookie}});
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), avatar);
    const saved = await (await fetch(base + '/api/state', {headers:{Cookie}})).json();
    assert.equal(saved.config.users[0].profile.userId, '123456789012');
    assert.ok(!JSON.stringify(saved).includes('private-hash'));
    assert.equal((await fetch(base + '/api/accounts/avatar?account=unknown', {headers:{Cookie}})).status, 404);
    fs.unlinkSync(path.join(root, 'offline.session'));
    assert.equal((await fetch(url, {headers:{Cookie}})).status, 404, 'orphaned cache is not served');
    const noSession = await fetch(base + '/api/accounts/profile/refresh', {method:'POST', headers:{Cookie, 'Content-Type':'application/json'}, body:JSON.stringify({account:'offline'})});
    assert.equal(noSession.status, 400);
    fs.writeFileSync(file, '{invalid'); assert.equal(store.view('offline'), null);
    console.log('Account profiles PASS: cache/privacy, profile-only lock/session gate, authenticated avatar API, orphan cache, corrupted cache');
  } finally {
    if (server) { const stopped = new Promise(r => server.once('close', r)); server.kill(); await stopped; }
    fs.rmSync(root, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
