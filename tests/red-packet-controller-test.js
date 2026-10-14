// Worker state and failures must reach account-scoped, persistent packet logs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function controller() {
  let child;
  const exported = { exports: {} };
  const context = {
    module: exported, process,
    setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit('close', null));
      child.event = data => child.stdout.write(JSON.stringify(data) + '\n');
      return child;
    } } : name === 'node:fs' ? { existsSync: () => options.sessionReady } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../automation.js'), 'utf8'), context);
  const events = [];
  const options = { root: '/offline', dataDir: '/offline', sessionReady: true,
    store: { read: () => ({}), refresh: async () => {} },
    readConfig: () => ({ telegram: { users: [{session:'Labubu'}] }, automations: {
      redPackets: [{id:'packet_rule',name:'红包监听',account:'Labubu',enabled:true},
                   {id:'disabled_rule',account:'Labubu',enabled:false}] } }),
    pythonCommand: () => ({name:'offline-python',version:'3.11'}),
    onEvent: event => events.push(event), canRun: () => true };
  const automation = exported.exports.createAutomation();
  automation.configure(options);
  return {automation, events, options, child: () => child};
}

(async () => {
  for (const [change, status, text] of [
    [o => o.pythonCommand = () => null, 'unavailable', '未找到 Python'],
    [o => o.sessionReady = false, 'unavailable', '缺少 Session'],
    [o => o.canRun = () => false, 'paused', '自动化暂未启动'],
  ]) {
    const test = controller(); change(test.options); test.automation.start();
    assert.equal(test.automation.getState().status, status);
    const notice = test.events.find(event => event.category === 'red_packet');
    assert.ok(notice.message.includes(text));
    assert.equal(notice.account, 'Labubu'); assert.equal(notice.ruleId, 'packet_rule');
    const count = test.events.length; test.automation.start();
    assert.equal(test.events.length, count, 'identical startup errors do not flood logs');
  }
  const test = controller(); test.automation.start();
  assert.equal(test.automation.getState().status, 'starting');
  assert.ok(test.events.some(event => event.category === 'red_packet' && event.message.includes('正在连接')));
  const count = test.events.length;
  test.child().event({type:'red_packet_status',account:'Labubu',groups:[{
    chatId:'-1003403977616',title:'NiuBi-Emby',ruleIds:['packet_rule'],received:12,
    commands:2,packets:1,lastReceivedAt:100,fallbackChecks:3}]});
  assert.equal(test.automation.getState().redPackets.Labubu.groups[0].received, 12);
  assert.equal(test.events.length, count, 'health counters do not create history records');
  test.child().event({type:'ready',message:'监听中'});
  assert.equal(test.automation.getState().status, 'running');
  test.child().event({type:'log',category:'red_packet',account:'Labubu',ruleId:'packet_rule',state:'running',message:'发现 /red'});
  assert.equal(test.events.at(-1).ruleId, 'packet_rule');
  test.child().stderr.write('offline connection error\n');
  assert.ok(test.events.some(event => event.category === 'red_packet' && event.message.includes('offline connection error')));
  test.child().event({type:'fatal',message:'没有可用的已登录账号'});
  assert.equal(test.automation.getState().status, 'failed');
  assert.equal(test.events.at(-1).state, 'failed');
  await test.automation.stop();
  assert.ok(test.events.some(event => event.category === 'red_packet' && event.state === 'stopped'));
  assert.equal(test.automation.getState().status, 'paused');
  assert.ok(test.events.every(event => event.ruleId !== 'disabled_rule'));
  console.log('Red packet controller PASS: categorized startup/pause/session/stderr/fatal logs, health state, dedupe');
})().catch(error => { console.error(error); process.exitCode = 1; });
