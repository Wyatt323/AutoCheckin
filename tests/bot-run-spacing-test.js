// Subprocess fixture signs nothing: verifies --bot isolation and gaps across runs.
require('./auth-support');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autocheckin-bot-run-')); let server;
  try {
    for(const file of ['server.js','database.js','admin_auth.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','checkin_results.js','automation.js','login.js','schedule_time.js','run_history.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{users:[{name:'Offline',session:'offline',api_id:123,api_hash:'offline',bots:['@one_bot','@two_bot']}]},ai:{model:'',providers:[]},automations:{schedules:[],forwards:[]}}));
    fs.writeFileSync(path.join(root,'offline.session'),'not-a-real-session');
    fs.writeFileSync(path.join(root,'allinone.py'),"import json,sys\nprint(json.dumps(sys.argv[1:]),flush=True)\n");
    const localPython=path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const python=process.env.PYTHON_BIN||(fs.existsSync(localPython)?localPython:process.platform==='win32'?'python':'python3');
    const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
    const base=`http://127.0.0.1:${port}`;
    server=spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:String(port),PYTHON_BIN:python,AUTOCHECKIN_DATA_DIR:root},stdio:'ignore'});
    for(let i=0;i<50;i++){try{if((await fetch(base+'/api/state')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    const run=bot=>fetch(base+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'offline',bot})});
    assert.equal((await run('@one_bot')).status,200);
    let prior;
    for(let i=0;i<50;i++){prior=(await(await fetch(base+'/api/state')).json()).run;if(prior.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(prior.bot,'@one_bot');assert.equal(prior.state,'completed');
    assert.ok(prior.lines.some(line=>line.text==='["--account", "offline", "--bot", "@one_bot"]'));
    const response=await run('@two_bot');assert.equal(response.status,200);const next=(await response.json()).run;
    const gap=Date.parse(next.startedAt)-Date.parse(prior.finishedAt);
    assert.ok(gap>=5000 && gap<20000,`gap ${gap}ms must include a 5–15 second wait`);
    assert.equal(next.bot,'@two_bot');
    let completed;
    for(let i=0;i<50;i++){completed=(await(await fetch(base+'/api/state')).json()).run;if(completed.id===next.id && completed.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(completed.id,next.id);assert.equal(completed.state,'completed');
    console.log('Isolated Bot runs PASS: CLI account/bot arguments, record target, 5–15s gap across separate runs');
  } finally {if(server){const stopped=new Promise(r=>server.once('close',r));server.kill();await stopped;}fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
