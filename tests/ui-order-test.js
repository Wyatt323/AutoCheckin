const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createUiOrder,scopedStore,createDatabase}=require('../database');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-order-'));
  try {
    let order=createUiOrder({dataDir:root});
    assert.deepEqual(order.view(),{});
    await Promise.all([order.update({scope:'accounts',keys:['second','first']}),order.update({scope:'forward',keys:['forward:two','forward:one']}),order.update({scope:'packet',keys:['packet:two','packet:one']})]);
    order=createUiOrder({dataDir:root});
    assert.deepEqual(order.view(),{accounts:['second','first'],forward:['forward:two','forward:one'],packet:['packet:two','packet:one']},'file restart and concurrent scopes');
    const snapshot=order.view();snapshot.accounts.reverse();assert.equal(order.view().accounts[0],'second','views cannot mutate committed data');
    for(const input of [null,{}, {scope:'__proto__',keys:[]},{scope:'spam',keys:[]},{scope:'packet',keys:['same','same']},{scope:'forward',keys:['']},{scope:'forward',keys:[4]},{scope:'forward',keys:'oops'},{scope:'checkin:',keys:[]},{scope:'forward',keys:['\0']},{scope:'forward',keys:Array(2001).fill('x')}])assert.throws(()=>order.update(input));
    let fail=false,docs=new Map();
    const store={read:key=>docs.get(key),write:async(key,value)=>{if(fail)throw Error('disk unavailable');docs.set(key,structuredClone(value));},keys:()=>[...docs.keys()]};
    const aliceStore=scopedStore(store,'tenant:alice:'),bobStore=scopedStore(store,'tenant:bob:');
    const alice=createUiOrder({dataDir:root,store:aliceStore}),bob=createUiOrder({dataDir:root,store:bobStore});
    await alice.update({scope:'accounts',keys:['A','B']});await bob.update({scope:'accounts',keys:['B','A']});
    assert.deepEqual(alice.view().accounts,['A','B']);assert.deepEqual(bob.view().accounts,['B','A']);
    fail=true;await assert.rejects(alice.update({scope:'accounts',keys:['B','A']}),/disk unavailable/);
    assert.deepEqual(alice.view().accounts,['A','B'],'failed persistent writes do not publish new order');
    fail=false;await alice.update({scope:'checkin:A',keys:['checkin:A:two','checkin:A:one']});
    assert.deepEqual(createUiOrder({dataDir:root,store:aliceStore}).view().accounts,['A','B']);
    // Exercise the PostgreSQL migration transaction without opening a network connection.
    const id='11111111-1111-1111-1111-111111111111',dir=path.join(root,'.user-workspaces',id);
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.ui-order.json'),JSON.stringify({version:1,orders:{cleanup:['two','one']}}));
    docs=new Map([['config',{telegram:{users:[]}}]]);
    const pool={async connect(){let transaction;return {release(){},async query(sql,args){
      if(sql==='BEGIN')transaction=new Map(docs);if(sql==='COMMIT')docs=transaction;
      if(sql.startsWith('SELECT key, value'))return {rows:[...docs].map(([key,value])=>({key,value}))};
      if(sql.startsWith('SELECT key'))return {rows:sql.includes('migration:ui-order-v1') && !transaction.has('migration:ui-order-v1') ? [] : [{key:'migrated'}]};
      if(sql.startsWith('INSERT INTO autocheckin_documents(key,value)') && !transaction.has(args[0]))transaction.set(args[0],JSON.parse(args[1]));
      return {rows:[]};
    }};},async end(){}};
    let database=await createDatabase({dataDir:root,pool});
    assert.deepEqual(database.read('ui-order').orders.accounts,['second','first']);
    assert.deepEqual(scopedStore(database,'tenant:'+id+':').read('ui-order').orders.cleanup,['two','one']);await database.close();
    fs.writeFileSync(path.join(dir,'.ui-order.json'),'{invalid');
    database=await createDatabase({dataDir:root,pool});assert.deepEqual(database.read('tenant:'+id+':ui-order').orders.cleanup,['two','one'],'import only once');await database.close();
    console.log('UI order PASS: durable file/store, isolated users, concurrent scopes, rejected invalid input, failed write recovery, PostgreSQL import and restart');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
