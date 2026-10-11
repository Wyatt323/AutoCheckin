// Exercise the PostgreSQL import transaction without a database or external IO.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDatabase,scopedStore}=require('../database');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'personal-settings-migration-'));
  const alice='11111111-1111-1111-1111-111111111111',bob='22222222-2222-2222-2222-222222222222';
  const docs=new Map([['config',{telegram:{users:[]}}],['tenant:'+bob+':system-settings',{telegram:{api_id:999,api_hash:'database-bob'}}]]);
  let committed=false;
  try {
    fs.writeFileSync(path.join(root,'.personal-settings.json'),JSON.stringify({telegram:{api_id:888,api_hash:'owner-file'}}));
    for(const [id,api] of [[alice,123],[bob,456]]) {
      const directory=path.join(root,'.user-workspaces',id);fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(path.join(directory,'.system-settings.json'),JSON.stringify({telegram:{api_id:api,api_hash:'file-'+id}}));
    }
    const pool={async connect(){return {release(){},async query(sql,args){
      if(sql==='COMMIT')committed=true;
      if(sql.startsWith('SELECT key, value'))return {rows:[...docs].map(([key,value])=>({key,value}))};
      if(sql.startsWith('SELECT key'))return {rows:sql.includes('migration:personal-settings-v1') || sql.includes('migration:admin-personal-settings-v1') ? [] : [{key:'already-migrated'}]};
      if(sql.startsWith('INSERT INTO autocheckin_documents(key,value)') && !docs.has(args[0]))docs.set(args[0],JSON.parse(args[1]));
      return {rows:[]};
    }};},async end(){}};
    const database=await createDatabase({dataDir:root,pool});
    assert.equal(committed,true);assert.equal(scopedStore(database,'tenant:'+alice+':').read('system-settings').telegram.api_id,123);
    assert.equal(scopedStore(database,'tenant:'+bob+':').read('system-settings').telegram.api_hash,'database-bob','never overwrite existing database settings');
    assert.equal(database.read('personal-settings').telegram.api_id,888,'administrator personal file imports under its own key');
    assert.ok(docs.has('migration:personal-settings-v1'));await database.close();
    console.log('Personal settings migration PASS: scoped file import, database preservation and transaction commit');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
