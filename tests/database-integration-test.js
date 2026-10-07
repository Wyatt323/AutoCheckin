// Runs only against a caller-supplied test PostgreSQL server; creates/drops its own DB.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const net = require('node:net');
const { createDatabase } = require('../database');
const { createScheduler } = require('../checkin_scheduler');
const { createRunHistory } = require('../run_history');

(async () => {
  if (!process.env.AUTOCHECKIN_TEST_DATABASE_URL) { console.log('PostgreSQL integration skipped: set AUTOCHECKIN_TEST_DATABASE_URL'); return; }
  const { Pool } = require('pg');
  const admin = new Pool({connectionString:process.env.AUTOCHECKIN_TEST_DATABASE_URL});
  const name = 'autocheckin_test_' + randomUUID().replaceAll('-','');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'autocheckin-db-integration-'));
  const url = new URL(process.env.AUTOCHECKIN_TEST_DATABASE_URL); url.pathname = '/' + name;
  let store, server;
  const stopServer = async () => { if (server) { const stopped = new Promise(r => server.once('close',r)); server.kill(); await stopped; server = null; } };
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const config = {telegram:{users:[{name:'Legacy',session:'offline',api_id:123,api_hash:'offline-secret',bot_groups:{button:['@first_bot'],command:[]},checkin_schedules:[]}]},ai:{model:'',providers:[]},automations:{schedules:[],forwards:[]}};
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
    fs.writeFileSync(path.join(root,'offline.session'),'fake-offline-session');
    fs.writeFileSync(path.join(root,'.checkin-schedule-state.json'),JSON.stringify({claimed:{},pending:[],events:[],planned:{}}));
    fs.writeFileSync(path.join(root,'.automation-state.json'),JSON.stringify({sent:{old:'done'},claimed:{},planned:{}}));
    fs.mkdirSync(path.join(root,'logs')); fs.writeFileSync(path.join(root,'logs/run-history.json'),JSON.stringify({records:[]}));
    const digest = createHash('sha256').update('offline').digest('hex');
    fs.mkdirSync(path.join(root,'.account-profiles')); fs.writeFileSync(path.join(root,'.account-profiles',digest+'.json'),JSON.stringify({userId:'123456',dcId:2,avatar:null,updatedAt:'2026-10-07T00:00:00Z'}));
    fs.mkdirSync(path.join(root,'.bot-discovery')); fs.writeFileSync(path.join(root,'.bot-discovery',digest+'.json'),JSON.stringify({'@old_bot':{bot:'@old_bot',mode:'command',command:'/checkin'}}));
    const connectStore = () => createDatabase({dataDir:root,parseConfig:JSON.parse,pool:new Pool({connectionString:url.href})});
    fs.writeFileSync(path.join(root,'.automation-state.json'),'{invalid');
    await assert.rejects(connectStore(), 'invalid legacy JSON must abort the whole migration');
    fs.writeFileSync(path.join(root,'.automation-state.json'),JSON.stringify({sent:{old:'done'},claimed:{},planned:{}}));
    store = await connectStore();
    assert.equal(store.read('migration:files-v1').imported,6);
    assert.equal(store.read('profile:'+digest).userId,'123456');
    assert.equal(store.read('automation-state').sent.old,'done');
    const changed = structuredClone(store.read('config')); changed.telegram.users[0].name='Database';
    await store.write('config',changed); await store.close(); store=null;
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({...config,backupMustStay:true}));
    store=await connectStore(); assert.equal(store.read('config').telegram.users[0].name,'Database','restart cannot overwrite with old JSON');
    const localPython = path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const python = process.env.PYTHON_BIN || (fs.existsSync(localPython) ? localPython : process.platform==='win32'?'python':'python3');
    const result=spawnSync(python,['-c',"import storage, automation_worker; config=storage.read_document('config'); assert config['telegram']['users'][0]['name']=='Database'; storage.write_document('discovery:'+'"+digest+"', {'@new_bot':{'bot':'@new_bot','mode':'button'}}); automation_worker.save_sent({'python':'done'}); print('Python PostgreSQL read/write PASS')"],{cwd:path.join(__dirname,'..'),env:{...process.env,DATABASE_URL:url.href,PYTHONIOENCODING:'utf-8'},encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stderr); console.log(result.stdout.trim());
    await store.refresh('discovery:'+digest); assert.equal(store.read('discovery:'+digest)['@new_bot'].mode,'button');
    await store.refresh('automation-state'); assert.equal(store.read('automation-state').sent.python,'done');
    const executions=[];
    const scheduleConfig={telegram:{users:[{session:'offline',bot_schedules:{'@first_bot':{enabled:true,time:'09:30'}}}]}};
    const options={root,store,readConfig:()=>scheduleConfig,isBusy:()=>false,now:()=>new Date('2027-01-01T01:30:00Z'),runAccount:async(account,bot)=>executions.push([account,bot])};
    await createScheduler(options).tick(); await createScheduler(options).tick(); assert.deepEqual(executions,[['offline','@first_bot']]);
    const history=createRunHistory(root,store); const record=history.create('offline','scheduled'); record.state='completed'; record.bot='@first_bot'; await history.flush();
    assert.equal((await store.refresh('run-history')).records[0].bot,'@first_bot');
    await store.close(); store=null;
    const socket=net.createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r)); const port=socket.address().port; await new Promise(r=>socket.close(r));
    const base=`http://127.0.0.1:${port}`;
    const launch=async()=>{
      server=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:url.href,AUTOCHECKIN_DATA_DIR:root,PORT:String(port),PUBLIC_HOST:'127.0.0.1',ADMIN_PASSWORD:'offline-db-web'},stdio:'ignore'});
      for(let i=0;i<80;i++){try{if((await fetch(base+'/api/auth/status')).ok)return;}catch{} await new Promise(r=>setTimeout(r,100));}
      throw Error('Database-backed server did not start');
    };
    const auth=async()=>{const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'offline-db-web'})});return response.headers.get('set-cookie').split(';')[0];};
    await launch(); let Cookie=await auth();
    let state=await(await fetch(base+'/api/state',{headers:{Cookie}})).json();
    assert.equal(state.config.users[0].name,'Database'); assert.equal(state.config.users[0].profile.userId,'123456'); assert.equal(state.config.users[0].discoveredBots[0].bot,'@new_bot');
    state.config.users[0].bots[0].schedule={enabled:true,time:'23:59'};
    let response=await fetch(base+'/api/config',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify(state.config)});
    assert.equal(response.status,200,await response.text());
    await stopServer(); await launch(); Cookie=await auth();
    state=await(await fetch(base+'/api/state',{headers:{Cookie}})).json();
    assert.equal(state.config.users[0].bots[0].schedule.enabled,true); assert.equal(state.config.users[0].bots[0].schedule.time,'23:59');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config.json'))).backupMustStay,true,'legacy backup left untouched');
    response=await fetch(base+'/api/accounts/bots/discovery/reset',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({account:'offline',bot:'@new_bot'})}); assert.equal(response.status,200);
    const postConfig=async input=>fetch(base+'/api/config',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});
    const badTime=structuredClone(state.config); badTime.users[0].bots[0].schedule.time='25:00';
    assert.equal((await postConfig(badTime)).status,400,'reject invalid independent time');
    const grouped=structuredClone(state.config); grouped.users[0].botSource='folder'; grouped.users[0].dialogFolder='4'; grouped.users[0].bots=[];
    grouped.users[0].checkinSchedules=[{id:'folder_daily_001',enabled:true,repeat:'daily',time:'23:55'}];
    response=await postConfig(grouped); assert.equal(response.status,200,'folder-only accounts can schedule without a manual bot list');
    const emptyFolder=structuredClone(grouped); emptyFolder.users[0].dialogFolder=''; assert.equal((await postConfig(emptyFolder)).status,400);
    const manual=structuredClone(state.config); manual.users[0].botSource='configured'; manual.users[0].dialogFolder='4';
    response=await postConfig(manual); assert.equal(response.status,200);
    assert.equal((await response.json()).config.users[0].dialogFolder,'','manual source disables a retained folder draft');
    console.log('PostgreSQL integration PASS: atomic migration, source retention, restart, Node/Python state, durable schedules/history, web save/read/reset');
  } finally {
    await stopServer(); if(store) await store.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
