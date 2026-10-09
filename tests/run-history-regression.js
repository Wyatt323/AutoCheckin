const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunHistory, MAX_LINES, MAX_RUNS, MAX_EVENTS } = require('../run_history');
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
  const batch = reloaded.create(null, 'manual');
  batch.state = 'failed'; batch.accountStates = {alpha:'completed', beta:'failed'};
  batch.lines = [
    {time:'2026-10-06T00:00:00Z', text:'alpha only', account:'alpha'},
    {time:'2026-10-06T00:00:01Z', text:'beta only', account:'beta'},
    {time:'2026-10-06T00:00:02Z', text:'unknown batch', account:null}
  ];
  reloaded.appendEvent({account:'alpha', category:'message', message:'message sent', state:'completed'});
  reloaded.appendEvent({account:'beta', category:'forward', message:'forward failed', level:'error'});
  reloaded.flush();
  const alpha = reloaded.snapshot({account:'alpha'}).records;
  assert.deepEqual(alpha.flatMap(record => record.lines.map(line => line.text)), ['alpha only', 'message sent']);
  assert.equal(alpha[0].state, 'completed', 'other account failure does not change this account status');
  assert.equal(filterRunLogs(reloaded.snapshot().records, {account:'alpha', category:'checkin', status:'completed'}).length, 1);
  assert.equal(reloaded.snapshot({category:'forward'}).records[0].state, 'failed');
  assert.equal(reloaded.snapshot({account:'__all__'}).records.length, 1);
  const restored = createRunHistory(root);
  assert.equal(restored.snapshot({account:'alpha',category:'message'}).records[0].lines[0].text, 'message sent');
  assert.equal(restored.latest().id, batch.id, 'automation events do not replace the latest check-in task');
  for(let i=0;i<MAX_EVENTS+1;i++) restored.appendEvent({account:'alpha',category:'forward',message:`event ${i}`});
  restored.flush();
  assert.equal(restored.snapshot({category:'forward'}).records.length, MAX_EVENTS);
  const held = restored.create('held', 'manual');
  for (let i = 0; i < MAX_RUNS + 3; i++) {
    const item = restored.create('fast', 'manual'); item.state = 'completed'; restored.changed();
  }
  restored.flush();
  assert.ok(restored.find(held.id), 'long-running concurrent task remains addressable after many newer runs');
  assert.ok(JSON.parse(fs.readFileSync(path.join(root,'logs/run-history.json'),'utf8')).records.some(item => item.id === held.id));
  fs.writeFileSync(path.join(root, 'logs/run-history.json'), 'broken');
  assert.equal(createRunHistory(root).snapshot().records.length, 0);
  console.log('Run history/filter regression PASS: timezone, inclusive seconds, account/status, reset, bounded persistence, interrupted recovery, corrupt file');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
