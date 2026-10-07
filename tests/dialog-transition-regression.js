const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
(async () => {
  let reduce = false, nativeCloses = 0;
  const animations = [];
  const classes = new Set();
  const dialog = {open:false, classList:{add:x=>classes.add(x), remove:x=>classes.delete(x), contains:x=>classes.has(x)}, addEventListener(){}, showModal(){this.open=true;}, close(value){this.open=false;this.returnValue=value;nativeCloses++;}, animate(_frames,options){
    let finish, cancel;
    const finished = new Promise((resolve,reject)=>{finish=resolve;cancel=reject;}); finished.catch(()=>{});
    const animation={finished,cancel:()=>cancel(Error('cancelled')),finish,options}; animations.push(animation); return animation;
  }};
  const context=vm.createContext({document:{body:{},querySelectorAll:selector=>selector==='dialog'?[dialog]:[],addEventListener(){}},window:{matchMedia:()=>({matches:reduce}),addEventListener(){}},MutationObserver:class{observe(){}},WeakMap,WeakSet,Promise,setTimeout,queueMicrotask});
  vm.runInContext(fs.readFileSync(require.resolve('../public/ui-controls.js'),'utf8'),context);
  dialog.showModal(); assert.equal(dialog.open,true);
  const closing=dialog.close('done'); assert.equal(dialog.open,true,'keep modal in top layer during exit'); assert.equal(nativeCloses,0);
  assert.ok(classes.has('ui-dialog-closing')); animations.at(-1).finish(); await closing;
  assert.equal(dialog.open,false); assert.equal(dialog.returnValue,'done');
  dialog.showModal(); const stale=dialog.close(); dialog.showModal(); await stale;
  assert.equal(dialog.open,true,'reopen cancels pending close'); assert.equal(nativeCloses,1);
  const final=dialog.close(); animations.at(-1).finish(); await final;
  assert.equal(nativeCloses,2);
  reduce=true; const before=animations.length; dialog.showModal(); await dialog.close();
  assert.equal(animations.length,before,'reduced motion does not animate'); assert.equal(dialog.open,false);
  console.log('Dialog transitions PASS: delayed native close, reopen race, completion value, reduced-motion preference');
})().catch(error=>{console.error(error);process.exitCode=1;});
