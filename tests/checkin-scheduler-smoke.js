const assert = require('node:assert/strict');
const fs = require('node:fs');

const path = require('node:path');
const { createScheduler } = require('../checkin_scheduler');

async function main() {
  const tempBase = process.env.AUTOCHECKIN_TEST_TMPDIR || require('node:os').tmpdir();
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'autocheckin-scheduler-'));
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
    config.telegram.users[0].checkin_schedules.forEach(rule => { rule.enabled = false; });
    const history = restarted.getState().events;
    current = new Date('2027-01-04T01:30:00Z');
    await restarted.tick();
    assert.equal(runs.length, 3, 'disabled rules cannot run on the next day');
    assert.deepEqual(restarted.getState().events, history, 'disabling preserves historical scheduler events');
    assert.ok(fs.existsSync(path.join(root, '.checkin-schedule-state.json')));
    console.log('签到计划按账号触发、每日重复和重启去重检查通过');
  } finally {
    if (root.startsWith(tempBase + path.sep)) fs.rmSync(root, { recursive:true, force:true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
