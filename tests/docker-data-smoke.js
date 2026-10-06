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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-container-'));
  let child;
  try {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    for (const name of ['server.js', 'automation.js', 'login.js', 'checkin_scheduler.js']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(root, name));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      telegram: { users: [{ name: 'docker-user', session: 'docker-user', api_id: 123, api_hash: 'secret' }] },
      ai: { model: 'mock', providers: [{ name: 'mock', base_url: 'https://example.com/v1', api_key: 'secret' }] },
      automations: { schedules: [], forwards: [] }
    }));
    fs.writeFileSync(path.join(dataDir, 'docker-user.session'), 'session-placeholder');
    const port = await freePort();
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: { ...process.env, PORT: String(port), BIND_HOST: '0.0.0.0', PUBLIC_HOST: '127.0.0.1', AUTOCHECKIN_DATA_DIR: dataDir }, stdio: 'ignore'
    });
    const base = `http://127.0.0.1:${port}`;
    let state;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { state = await (await fetch(`${base}/api/state`)).json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(state, 'server started on container bind address');
    assert.equal(state.config.users[0].sessionReady, true);
    state.config.users[0].name = 'docker-updated';
    const response = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.config) });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).telegram.users[0].name, 'docker-updated');
    assert.equal(fs.existsSync(path.join(root, 'config.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, '.checkin-schedule-state.json')), true);
    console.log('容器数据目录的配置、Session 和调度状态检查通过');
  } finally {
    child?.kill();
    if (root.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
