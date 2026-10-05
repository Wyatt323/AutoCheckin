// Offline suite. Keep all scratch files in an isolated, automatically removed directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-suite-'));
const env = { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, PYTHONDONTWRITEBYTECODE: '1' };
let failed = false;
try {
  for (const name of fs.readdirSync(__dirname).sort()) {
    if (name === 'run-tests.js' || !(/(?:smoke|regression|test)\.(js|py)$/.test(name) || /^test_.*\.py$/.test(name))) continue;
    console.log(`\n=== ${name} ===`);
    const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    const result = spawnSync(name.endsWith('.js') ? process.execPath : python, [path.join(__dirname, name)], { cwd: root, env, stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) {
      console.error(`${name} FAILED: ${result.error?.message || result.status}`);
      failed = true;
    }
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
