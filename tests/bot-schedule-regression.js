const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createScheduler } = require('../checkin_scheduler');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocheckin-bot-schedule-'));
  try {
    const runs = [], now = () => new Date('2027-01-02T01:30:00Z');
    const user = {session:'one', checkin_schedules:[{id:'account_daily', repeat:'daily', time:'09:30'}], bot_schedules:{'@one_bot':{enabled:true,time:'09:30'}, '@off_bot':{enabled:false,time:'09:30'}}};
    const options = {root, readConfig:() => ({telegram:{users:[user]}}), now, isBusy:() => false, runAccount:async (account, bot) => runs.push([account,bot])};
    const scheduler = createScheduler(options);
    await scheduler.tick(); await scheduler.tick(); await scheduler.tick();
    assert.deepEqual(runs, [['one',null], ['one','@one_bot']]);
    await createScheduler(options).tick(); assert.equal(runs.length,2,'restart does not duplicate individual bot');
    user.dialog_folder = 'Sign-ins'; user.bot_schedules['@new_bot'] = {enabled:true,time:'09:30'};
    await scheduler.tick(); assert.equal(runs.length,2,'folder mode ignores manual bot schedules');
    const memory = new Map(); let fail = false;
    const store = {read:key => memory.get(key), write:async (key,value) => {if (fail) throw Error('offline database failure'); memory.set(key,structuredClone(value));}};
    user.dialog_folder = ''; user.checkin_schedules = [];
    const pgScheduler = createScheduler({...options,store});
    fail = true; const prior = runs.length; await pgScheduler.tick(); assert.equal(runs.length,prior,'durable claim required before starting');
    fail = false; await pgScheduler.tick(); await pgScheduler.tick();
    assert.equal(runs.length,prior+2);
    await createScheduler({...options,store}).tick(); assert.equal(runs.length,prior+2);
    console.log('Bot schedules PASS: independent target, disabled, folder precedence, durable claim, restart de-duplication');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
})().catch(error => {console.error(error);process.exitCode=1;});
