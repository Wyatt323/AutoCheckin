const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunHistory, MAX_LINES, MAX_RUNS } = require('../run_history');
const { filterRunLogs, beijingParts } = require('../public/run-log');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
try {
  const history = createRunHistory(root);
  const run = history.create('alpha', 'manual');
  run.lines.push({ id: 1, time: '2026-10-05T16:00:01Z', text: 'boundary' });
  history.changed(true);
  assert.deepEqual(beijingParts(run.lines[0].time), { date: '2026-10-06', time: '00:00:01' });
  const records = [run, { ...run, id: 'batch', account: null, state: 'completed' }];
  assert.equal(filterRunLogs(records, { date: '2026-10-06', start: '00:00:01', end: '00:00:01', account: 'alpha', status: 'running' }).length, 1);
  assert.equal(filterRunLogs(records, { date: '2026-10-05' }).length, 0);
  assert.equal(filterRunLogs(records, { account: '__all__', status: 'completed' }).length, 1);
  assert.equal(filterRunLogs(records, { start: '12:00', end: '11:00' }).length, 0);
  assert.equal(filterRunLogs(records, {}).length, 2);
  const reloaded = createRunHistory(root);
  assert.equal(reloaded.latest().state, 'failed');
  assert.match(reloaded.latest().lines.at(-1).text, /中断/);
  for (let i = 0; i < MAX_RUNS + 2; i++) {
    const item = reloaded.create(`user${i}`, 'manual');
    item.state = 'completed'; item.lines = Array.from({ length: 900 }, (_, id) => ({ id, time: '2026-10-06T00:00:00Z', text: 'bounded' }));
    reloaded.changed(true);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'logs/run-history.json'))).records;
  assert.equal(saved.length, MAX_RUNS);
  assert.ok(saved.reduce((n, item) => n + item.lines.length, 0) <= MAX_LINES);
  assert.ok(saved.every(item => item.lines.length <= 800));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'logs/run-history.json')).mode & 0o777, 0o600);
  assert.equal(createRunHistory(root).latest().state, 'completed');
  fs.writeFileSync(path.join(root, 'logs/run-history.json'), 'broken');
  assert.equal(createRunHistory(root).snapshot().records.length, 0);
  console.log('Run history/filter regression PASS: timezone, inclusive seconds, account/status, reset, bounded persistence, interrupted recovery, corrupt file');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
