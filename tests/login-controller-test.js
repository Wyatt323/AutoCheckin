const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { createLoginController } = require('../login');
function fake() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.kill = signal => child.kills.push(signal);
  child.event = data => child.stdout.write(JSON.stringify(data) + '\n');
  return child;
}
(async () => {
  let child, stopped = 0, resumed = 0, busy = false;
  const opts = { root:'/isolated', dataDir:'/isolated/data', readConfig:() => ({telegram:{users:[{session:'offline', api_id:123, api_hash:'never-log'}]}}), pythonCommand:() => ({name:'python',prefix:[]}), isBusy:() => busy, stopAutomation:async () => { stopped++; }, resumeAutomation:() => {resumed++;}, spawnWorker:(name,args,options) => {
    assert.equal(options.env.AUTOCHECKIN_DATA_DIR, '/isolated/data'); assert.ok(args.includes(path.join('/isolated', 'login_worker.py'))); assert.ok(!args.includes('never-log')); child = fake(); return child;
  } };
  const login = createLoginController(opts);
  busy = true; await assert.rejects(login.start('offline')); busy = false;
  await assert.rejects(login.start('../bad'));
  const state = await login.start('offline'); assert.equal(stopped,1); assert.ok(login.active());
  await assert.rejects(login.start('offline'));
  child.event({type:'QR',png:'aGVsbG8=',expiresAt:'tomorrow'}); assert.equal(login.status().state,'qr');
  assert.throws(() => login.password(state.id,'secret'));
  child.event({type:'password_required'}); assert.equal(login.status().png,undefined);
  assert.throws(() => login.password('stale','secret')); assert.throws(() => login.password(state.id,'x'.repeat(257)));
  let input=''; child.stdin.on('data',chunk => {input += chunk;});
  login.password(state.id,'secret'); assert.equal(JSON.parse(input).password,'secret'); assert.ok(!JSON.stringify(login.status()).includes('secret'));
  child.event({type:'password_required',invalid:true}); assert.equal(login.status().state,'password_required');
  child.event({type:'success'}); assert.equal(login.status().active,true); child.emit('close',0);
  assert.equal(login.status().state,'success'); assert.equal(resumed,1); assert.equal(login.active(),false);
  const next = await login.start('offline'); login.cancel(next.id); assert.equal(login.status().state,'cancelled'); assert.equal(login.active(),true);
  child.event({type:'success'}); assert.equal(login.status().state,'cancelled'); assert.deepEqual(child.kills,['SIGTERM']); child.emit('close',null);
  assert.equal(resumed,2);
  const failing = await login.start('offline'); child.stderr.write('api_hash secret tg://login?token=secret'); child.event({type:'error',message:'secret'}); child.emit('close',2);
  assert.equal(login.status().state,'error'); assert.ok(!JSON.stringify(login.status()).includes('secret'));
  await login.start('offline'); const shutdown = login.shutdown(); child.emit('close',null); await shutdown;
  let release;
  const pending = createLoginController({...opts, stopAutomation:() => new Promise(resolve => {release=resolve;})});
  const starting = pending.start('offline'); assert.ok(pending.active()); pending.cancel(pending.status().id); release(); await assert.rejects(starting); assert.equal(pending.active(),false);
  const timeout = createLoginController({...opts,timeoutMs:5}); await timeout.start('offline'); await new Promise(resolve => setTimeout(resolve,20)); assert.equal(timeout.status().state,'error'); child.emit('close',null);
  const inherited = createLoginController({...opts, readConfig:() => ({telegram:{api_id:789,api_hash:'global-secret',users:[{session:'offline'}]}})});
  await inherited.start('offline'); assert.ok(inherited.active()); child.emit('close',0);
  const missing = createLoginController({...opts, readConfig:() => ({telegram:{users:[{session:'offline'}]}})});
  await assert.rejects(missing.start('offline')); assert.equal(missing.active(),false);
  console.log('login controller: busy, QR, 2FA retry, cancellation, shutdown, redaction, timeout PASS');
})().catch(error => {console.error(error); process.exitCode=1;});
