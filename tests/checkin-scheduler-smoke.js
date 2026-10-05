const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduler } = require('../checkin_scheduler');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-scheduler-'));
  try {
    let current = new Date('2027-01-02T01:30:00Z');
    const runs = [];
    const config = { telegram: { users: [{ name:'first', session:'first', checkin_schedules:[
      { id:'daily_test_001', enabled:true, repeat:'daily', time:'09:30' },
      { id:'once_test_001', enabled:true, repeat:'once', time:'2027-01-02T09:30' }
    ] }] } };
    const options = { root, readConfig: () => config, runAccount: async account => runs.push(account), isBusy: () => false, now: () => current };
    const scheduler = createScheduler(options);
    await scheduler.tick();
    assert.equal(runs.length, 1);
    await scheduler.tick();
    assert.equal(runs.length, 2);
    await scheduler.tick();
    assert.equal(runs.length, 2);
    const restarted = createScheduler(options);
    await restarted.tick();
    assert.equal(runs.length, 2, 'restart must not duplicate occurrence');
    current = new Date('2027-01-03T01:30:00Z');
    await restarted.tick();
    assert.equal(runs.length, 3, 'daily rule fires next day');
    assert.ok(fs.existsSync(path.join(root, '.checkin-schedule-state.json')));
    console.log('签到计划按账号触发、每日重复和重启去重检查通过');
  } finally {
    if (root.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive:true, force:true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
