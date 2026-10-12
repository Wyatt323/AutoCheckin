// Exercise migration and tenant keys with an injected offline PostgreSQL pool.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createDatabase,scopedStore}=require('../database');

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'red-packet-storage-')),tenant=randomUUID();
  const documents=new Map([['config',{telegram:{users:[]}}]]),operations=[];
  const tenantRoot=path.join(root,'.user-workspaces',tenant);
  const execute=async(sql,args=[])=>{
    operations.push([sql,args]);
    if(sql.startsWith('SELECT key, value'))return {rows:[...documents].map(([key,value])=>({key,value}))};
    if(sql.startsWith('SELECT key'))return {rows:sql.includes('red-packets-v1') && !documents.has('migration:red-packets-v1')?[]:[{}]};
    if(sql.startsWith('SELECT value'))return {rows:documents.has(args[0])?[{value:documents.get(args[0])}]:[]};
    if(sql.startsWith('INSERT')){
      const key=args[0],value=JSON.parse(args[1]);
      if(!documents.has(key)||!sql.includes('DO NOTHING'))documents.set(key,value);
    }
    return {rows:[],rowCount:1};
  };
  const pool={connect:async()=>({query:execute,release(){}}),query:execute,end:async()=>{}};
  try{
    fs.mkdirSync(tenantRoot,{recursive:true});
    fs.writeFileSync(path.join(root,'.red-packet-state.json'),JSON.stringify({admin:{time:1,result:'success'}}));
    fs.writeFileSync(path.join(tenantRoot,'.red-packet-state.json'),JSON.stringify({tenant:{time:2,result:'exhausted'}}));
    let store=await createDatabase({dataDir:root,pool});
    assert.equal(store.read('red-packet-state').admin.result,'success');
    assert.equal(store.read(`tenant:${tenant}:red-packet-state`).tenant.result,'exhausted');
    assert.ok(operations.findIndex(([sql])=>sql==='COMMIT')>operations.findIndex(([sql,args])=>args[0]==='migration:red-packets-v1'));
    const scoped=scopedStore(store,`tenant:${tenant}:`);
    await scoped.write('red-packet-state',{newPacket:{time:3,result:'success'}});
    assert.equal(scoped.read('red-packet-state').newPacket.result,'success');
    assert.equal(store.read('red-packet-state').admin.result,'success','tenant write leaves administrator state intact');
    await store.close();
    fs.writeFileSync(path.join(tenantRoot,'.red-packet-state.json'),'{}');
    store=await createDatabase({dataDir:root,pool});
    assert.ok(store.read(`tenant:${tenant}:red-packet-state`).newPacket,'old files do not overwrite migrated data on restart');
    await store.close();
    console.log('Red packet storage PASS: transactional file import, separate tenant keys, restart without overwrite');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
