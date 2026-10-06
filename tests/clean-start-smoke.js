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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-clean-'));
  let child;
  try {
    for (const name of ['server.js', 'automation.js', 'login.js', 'schedule_time.js', 'checkin_scheduler.js', 'telegram_credentials.js', 'config.example.json']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(root, name));
    const port = await freePort();
    child = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: String(port), AUTOCHECKIN_DATA_DIR: root }, stdio: 'ignore' });
    let state;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(state, 'server starts without personal config');
    assert.deepEqual(state.config.users, []);
    assert.deepEqual(state.config.providers, []);
    assert.equal(fs.existsSync(path.join(root, 'config.json')), true);
    console.log('公开源码的空配置首次启动检查通过');
  } finally {
    child?.kill();
    if (root.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
