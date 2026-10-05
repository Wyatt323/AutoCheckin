const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../checkin_scheduler');

async function main() {
  const tempBase = process.env.AUTOCHECKIN_TEST_TMPDIR || require('node:os').tmpdir();
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'js-regression-'));
  try {
    const rule = { id: 'shared:id', repeat: 'daily', time: '09:30' };
    let current = new Date('2027-01-02T01:30:00Z');
    let busy = true;
    const config = { telegram: { users: ['first', 'second'].map(session => ({ session, checkin_schedules: [{ ...rule }] })) } };
    const runs = [];
    const options = { root, readConfig: () => config, now: () => current, isBusy: () => busy, runAccount: async account => runs.push(account) };
    let scheduler = createScheduler(options);
    await scheduler.tick();
    assert.equal(scheduler.getState().queued, 2, 'shared rule IDs must not collide');
    const originalWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (...args) => { writes++; return originalWrite(...args); };
    try { await scheduler.tick(); assert.equal(writes, 0, 'unchanged ticks must not rewrite disk'); }
    finally { fs.writeFileSync = originalWrite; }
    scheduler = createScheduler(options);
    busy = false;
    const previousError = console.error;
    console.error = () => {};
    fs.writeFileSync = () => { throw new Error('injected dequeue write failure'); };
    try {
      await scheduler.tick();
      assert.equal(runs.length, 0, 'must not launch before queue removal is committed');
      assert.equal(scheduler.getState().queued, 2, 'failed dequeue write retains pending work');
    } finally { fs.writeFileSync = originalWrite; console.error = previousError; }
    await scheduler.tick(); await scheduler.tick(); await scheduler.tick();
    assert.deepEqual(runs, ['first', 'second']);
    current = new Date('2027-01-03T01:30:00Z');
    busy = true;
    fs.writeFileSync = () => { throw new Error('injected disk failure'); };
    const originalError = console.error;
    console.error = () => {};
    try { await scheduler.tick(); assert.equal(scheduler.getState().queued, 0, 'failed persistence rolls back claims'); }
    finally { fs.writeFileSync = originalWrite; console.error = originalError; }
    await scheduler.tick();
    assert.equal(scheduler.getState().queued, 2, 'failed claims are retried');
    config.telegram.users[0].checkin_schedules[0].enabled = false;
    await scheduler.tick();
    assert.equal(scheduler.getState().queued, 1, 'disabled queued rules are removed, including colon IDs');

    // Legacy state migrates without replaying completed occurrences.
    fs.writeFileSync(path.join(root, '.checkin-schedule-state.json'), JSON.stringify({ claimed: { 'shared:id:2027-01-03': 'claimed' }, pending: [{ account: 'second', key: 'shared:id:2027-01-03' }], events: [] }));
    scheduler = createScheduler(options);
    await scheduler.tick();
    assert.equal(scheduler.getState().queued, 1);
    busy = false;
    await scheduler.tick();
    assert.deepEqual(runs, ['first', 'second', 'second']);

    const workers = [];
    let timers = [];
    const fakeSpawn = () => {
      const worker = new EventEmitter();
      worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
      worker.stdout.setEncoding = worker.stderr.setEncoding = () => {};
      worker.signals = [];
      worker.kill = signal => { worker.signals.push(signal); return true; };
      workers.push(worker);
      return worker;
    };
    const sandbox = {
      module: { exports: {} }, process,
      require: name => name === 'node:child_process' ? { spawn: fakeSpawn } : name === 'node:fs' ? { existsSync: () => true } : require(name),
      setTimeout: callback => { const timer = { callback, cleared: false, unref() {} }; timers.push(timer); return timer; },
      clearTimeout: timer => { if (timer) timer.cleared = true; }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../automation.js'), 'utf8'), sandbox);
    const automation = sandbox.module.exports;
    automation.configure({ root, readConfig: () => ({ telegram: { users: [{ session: 'fake' }] }, automations: { schedules: [{ account: 'fake' }] } }), pythonCommand: () => ({ name: 'fake', prefix: [], version: 'test' }) });
    automation.start(); automation.start();
    assert.equal(workers.length, 1);
    const stopping = automation.stop();
    assert.equal(automation.stop(), stopping, 'concurrent stops share completion');
    automation.start();
    assert.equal(workers.length, 1, 'start during stop must not create competing worker');
    workers[0].stdout.emit('data', '{"type":"ready"}\n');
    assert.equal(automation.getState().status, 'stopping', 'late ready cannot undo stop');
    timers.find(timer => !timer.cleared).callback();
    assert.deepEqual(workers[0].signals, ['SIGTERM', 'SIGKILL']);
    workers[0].emit('close', null);
    await stopping;
    assert.equal(automation.getState().status, 'paused');
    assert.ok(timers.every(timer => timer.cleared));
    automation.start();
    const failedStop = automation.stop();
    const rejection = assert.rejects(failedStop, /停止超时/);
    const firstDeadline = timers.find(timer => !timer.cleared);
    firstDeadline.callback();
    timers.find(timer => !timer.cleared && timer !== firstDeadline).callback();
    await rejection;
    automation.start();
    assert.equal(workers.length, 2, 'unconfirmed exit retains session ownership');
    workers[1].emit('close', null);
    automation.start();
    workers[2].emit('close', 1);
    await automation.stop();
    assert.ok(timers.every(timer => timer.cleared), 'stop cancels retry');
    // Exercise actual OS process termination, without Python, Telegram or session files.
    const childProcess = require('node:child_process');
    const realWorkers = [];
    const realSandbox = {
      module: { exports: {} }, process, setTimeout, clearTimeout,
      require: name => name === 'node:child_process' ? { spawn: () => {
        const child = childProcess.spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); console.log('{"type":"ready"}'); setInterval(() => {}, 1000);`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        realWorkers.push(child);
        return child;
      } } : name === 'node:fs' ? { existsSync: () => true } : require(name)
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../automation.js'), 'utf8'), realSandbox);
    const realAutomation = realSandbox.module.exports;
    realAutomation.configure({ root, stopTimeoutMs: 100, readConfig: () => ({ users: [{ session: 'fake' }], automations: { schedules: [{ account: 'fake' }] } }), pythonCommand: () => ({ name: 'unused', prefix: [], version: 'test' }) });
    try {
      realAutomation.start();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fixture readiness timeout')), 3000);
        realWorkers[0].stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      });
      await realAutomation.stop();
      assert.equal(realWorkers[0].signalCode, 'SIGKILL', 'SIGTERM-resistant real worker must be killed');
      assert.equal(realAutomation.getState().status, 'paused');
    } finally { for (const worker of realWorkers) if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); }
    console.log('JS scheduler/lifecycle regressions passed (fake sessions; mocked and real workers)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
