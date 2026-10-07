const { authenticatePage } = require('./auth-support');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-smoke-'));
  let child;
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'telegram_credentials.js'), path.join(directory, 'telegram_credentials.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(directory, 'server.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'login.js'), path.join(directory, 'login.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'automation.js'), path.join(directory, 'automation.js'));
    for (const file of ['database.js', 'account_profiles.js', 'admin_auth.js','user_auth.js', 'schedule_time.js', 'run_history.js', 'checkin_scheduler.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(directory, file));
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
      telegram: { users: [{ name: 'test', session: 'test', api_id: 123, api_hash: 'secret-hash' }, { name: 'second', session: 'second', api_id: 456, api_hash: 'second-hash' }] },
      ai: { model: 'test-model', providers: [{ name: 'primary', base_url: 'https://example.com/v1', api_key: 'secret-key' }] },
      bot_groups: { button: ['@example_bot'], command: [] }
    }));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(directory, 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    let response;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { response = await fetch(`${base}/api/state`); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(response?.ok, 'server started');
    const state = await response.json();
    const statusOnly = await (await fetch(`${base}/api/state?config=0`)).json();
    assert.equal(Object.hasOwn(statusOnly, 'config'), false, 'routine polling omits configuration');
    for (const key of ['run', 'automation', 'checkinScheduler', 'python']) assert.ok(Object.hasOwn(statusOnly, key), key);
    assert.equal(statusOnly.run.state, state.run.state);
    assert.equal(state.config.users[0].bots[0].note, '');
    assert.equal(state.config.users[1].bots[0].name, '@example_bot');
    const accountOnly = structuredClone(state.config);
    accountOnly.providers = [];
    accountOnly.model = '';
    const partial = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accountOnly) });
    assert.equal(partial.status, 200, 'accounts can be saved before AI setup');
    const aiOnly = structuredClone(state.config);
    aiOnly.users = [];
    aiOnly.providers[0].apiKey = 'secret-key';
    const aiSaved = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aiOnly) });
    assert.equal(aiSaved.status, 200, 'AI can be saved before accounts');
    // Restore initial keys before exercising empty-input secret retention.
    state.config.users[0].apiHash = 'secret-hash';
    state.config.users[1].apiHash = 'second-hash';
    state.config.providers[0].apiKey = 'secret-key';
    state.config.users[0].bots[0].note = '每日签到站点 ,} ,] "quoted"';
    state.config.users[0].bots[0].mode = 'command';
    state.config.users[0].bots[0].command = '/checkin';
    state.config.users[1].bots = [{ name:'@another_bot', mode:'button', command:'/sign', note:'第二账号专属' }];
    state.config.users[0].checkinSchedules.push({ id:'checkin_test_001', enabled:true, repeat:'daily', time:'09:30' });
    state.config.users[1].checkinSchedules.push({ id:'checkin_test_002', enabled:false, repeat:'once', time:'2027-01-02T10:15' });
    state.config.automations.schedules.push({ id:'schedule_test_001', enabled:true, account:'test', target:'@target_group', repeat:'daily', time:'09:30', message:'测试定时消息' });
    state.config.automations.forwards.push({ id:'forward_test_001', enabled:true, account:'test', source:'@source_group', target:'@target_group' });
    const saved = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.config) });
    assert.equal(saved.status, 200);
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    assert.equal(persisted.telegram.users[0].bot_notes['@example_bot'], '每日签到站点 ,} ,] "quoted"');
    assert.deepEqual(persisted.telegram.users[0].bot_groups.command, [{ bot: '@example_bot', command: '/checkin' }]);
    assert.deepEqual(persisted.telegram.users[1].bot_groups.button, ['@another_bot']);
    assert.equal(persisted.bot_groups, undefined);
    assert.equal(persisted.telegram.users[0].api_hash, 'secret-hash');
    assert.equal(persisted.telegram.users[1].api_hash, 'second-hash');
    assert.equal(persisted.ai.providers[0].api_key, 'secret-key');
    assert.equal(persisted.automations.schedules[0].time, '09:30');
    assert.equal(persisted.automations.forwards[0].source, '@source_group');
    assert.equal(persisted.telegram.users[0].checkin_schedules[0].time, '09:30');
    assert.equal(persisted.telegram.users[1].checkin_schedules[0].enabled, false);
    const refreshed = await (await fetch(`${base}/api/state`)).json();
    assert.equal(refreshed.config.users[0].bots[0].note, '每日签到站点 ,} ,] "quoted"');
    assert.equal(refreshed.config.users[1].bots[0].name, '@another_bot');
    assert.equal(refreshed.config.automations.schedules[0].message, '测试定时消息');
    assert.equal(refreshed.config.users[0].checkinSchedules[0].repeat, 'daily');
    const invalid = structuredClone(refreshed.config);
    invalid.automations.forwards.push({ id:'forward_test_002', enabled:true, account:'test', source:'@target_group', target:'@source_group' });
    const rejected = await fetch(`${base}/api/config`, { method:'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(invalid) });
    assert.equal(rejected.status, 400);
    const invalidDate = structuredClone(refreshed.config);
    invalidDate.users[1].checkinSchedules[0].time = '2027-02-30T10:15';
    const badDateResponse = await fetch(`${base}/api/config`, { method:'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(invalidDate) });
    assert.equal(badDateResponse.status, 400);
    console.log('按账号保存 Bot、旧配置迁移、自动化规则和密钥保留检查通过');
  } finally {
    child?.kill();
    if (directory.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
