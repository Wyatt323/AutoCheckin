// Verify the health import transaction and user scopes with an offline PostgreSQL adapter.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDatabase,scopedStore}=require('../database');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-migration-'));
  const alice='11111111-1111-1111-1111-111111111111',bob='22222222-2222-2222-2222-222222222222';
  const aliceKey='tenant:'+alice+':health-state',bobKey='tenant:'+bob+':health-state';
  let docs=new Map([['config',{telegram:{users:[]}}],[bobKey,{settings:{intervalSeconds:300}}]]),rolledBack=false,ended=false;
  const directory=id=>path.join(root,'.user-workspaces',id);
  const file=id=>path.join(id ? directory(id) : root,'.health-state.json');
  const pool={async connect(){let transaction;return {release(){},async query(sql,args){
    if(sql==='BEGIN')transaction=new Map(docs);
    if(sql==='COMMIT')docs=transaction;
    if(sql==='ROLLBACK')rolledBack=true;
    if(sql.startsWith('SELECT key, value'))return {rows:[...docs].map(([key,value])=>({key,value}))};
    if(sql.startsWith('SELECT key'))return {rows:sql.includes('migration:health-state-v1') && !transaction.has('migration:health-state-v1') ? [] : [{key:'already-migrated'}]};
    if(sql.startsWith('INSERT INTO autocheckin_documents(key,value)')){const value=JSON.parse(args[1]);if(!transaction.has(args[0]))transaction.set(args[0],value);}
    return {rows:[]};
  }};},async end(){ended=true;}};
  try {
    for(const id of [alice,bob])fs.mkdirSync(directory(id),{recursive:true});
    fs.writeFileSync(file(),JSON.stringify({settings:{intervalSeconds:120}}));
    fs.writeFileSync(file(alice),JSON.stringify({settings:{intervalSeconds:60},incidents:{outage:{id:'saved-incident',lastAlertAt:123}}}));
    fs.writeFileSync(file(bob),'{invalid');
    await assert.rejects(createDatabase({dataDir:root,pool}),/JSON/);
    assert.ok(rolledBack && ended,'malformed imports roll back and release the pool');
    assert.ok(!docs.has(aliceKey),'a partial import is never committed');
    fs.writeFileSync(file(bob),JSON.stringify({settings:{intervalSeconds:30}}));
    let database=await createDatabase({dataDir:root,pool});
    assert.equal(database.read('health-state').settings.intervalSeconds,120);
    assert.equal(scopedStore(database,'tenant:'+alice+':').read('health-state').incidents.outage.lastAlertAt,123);
    assert.equal(scopedStore(database,'tenant:'+bob+':').read('health-state').settings.intervalSeconds,300,'existing database values take precedence');
    await database.close();
    fs.writeFileSync(file(alice),'{invalid');
    database=await createDatabase({dataDir:root,pool});
    assert.equal(database.read(aliceKey).settings.intervalSeconds,60,'completed migration does not import old files again');
    await database.close();
    assert.ok(fs.existsSync(file()),'source files are preserved');
    console.log('Health migration PASS: transactional import/rollback, user scopes, retained cooldown, database precedence and restart dedup');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
