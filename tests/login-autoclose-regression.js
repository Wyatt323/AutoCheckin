const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
(async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { open: false, value: '', textContent: '', addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){}, showModal(){this.open=true;}, close(){this.open=false;} });
    return elements.get(id);
  };
  let resolveRefresh, refreshed = 0;
  const context = vm.createContext({ document: { createElement:()=>element('#login-dialog'), body:{append(){}}, addEventListener(){} }, window:{addEventListener(){}}, $:element, $$:()=>[], config:{users:[{session:'one'}]}, currentRun:null, api: url => url === '/api/state' ? new Promise(r=>{resolveRefresh=r;}) : new Promise(()=>{}), readEditors(){}, renderConfig(){refreshed++;}, toast(){}, setInterval(){return 1;}, clearInterval(){} });
  vm.runInContext(fs.readFileSync(require.resolve('../public/login.js'),'utf8'),context);
  const render = state => vm.runInContext(`renderLogin(${JSON.stringify(state)})`,context);
  render({id:'old',state:'qr',active:true,account:'one'});
  render({id:'old',state:'success',active:true,account:'one'});
  assert.equal(element('#login-dialog').open,true,'worker still active must not close');
  render({id:'old',state:'success',active:false,account:'one'});
  assert.equal(element('#login-dialog').open,true,'refresh pending must not close');
  render({id:'new',state:'qr',active:true,account:'two'});
  resolveRefresh({config:{users:[{session:'one',sessionReady:true}]}}); await new Promise(r=>setImmediate(r));
  assert.equal(element('#login-dialog').open,true,'old refresh must not close new login'); assert.equal(refreshed,0);
  render({id:'new',state:'failed',active:false,message:'offline error'}); assert.equal(element('#login-dialog').open,true);
  render({id:'final',state:'qr',active:true,account:'one'});
  render({id:'final',state:'success',active:false,account:'one'});
  resolveRefresh({config:{users:[{session:'one',sessionReady:true}]}}); await new Promise(r=>setImmediate(r));
  assert.equal(element('#login-dialog').open,false); assert.equal(context.config.users[0].sessionReady,true); assert.equal(refreshed,1);
  console.log('Login auto-close regression PASS: worker exit gate, refresh gate, unrelated id race, error remains visible, refreshed success closes');
})().catch(error=>{console.error(error);process.exitCode=1;});
