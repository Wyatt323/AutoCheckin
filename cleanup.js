const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

function createCleanupController(context) {
  const {root,dataDir,store,workerEnv,history} = context;
  const active = new Map();
  const directory = path.join(dataDir,'.cleanup-jobs');
  let closing = false;
  function view() {
    const records=history.snapshot({category:'plugin'}).records.filter(run=>run.plugin==='zeroSpeakers');
    const retained=new Set([...records.filter(run=>['running','stopping'].includes(run.state)),...records.filter(run=>!['running','stopping'].includes(run.state)).slice(-20)]);
    return records.filter(run=>retained.has(run)).map(run=>({...run,lines:run.lines.slice(-150)}));
  }
  function line(run,text,stream='system') {
    run.lines.push({id:(run.lines.at(-1)?.id || 0)+1,time:new Date().toISOString(),text:String(text).slice(0,2000),stream,runId:run.id,account:run.account,trigger:'manual'});
    history.changed();
  }
  async function start(ruleId) {
    if(closing || !context.canStart())throw Error('服务正在停止');
    const config = context.readConfig();
    const rule = config.plugins?.zeroSpeakers?.find(rule=>rule.id===ruleId);
    if(!rule)throw Error('请先保存清理规则');
    const account = config.telegram?.users?.find(user=>(user.session || user.name)===rule.account);
    if(!account || !fs.existsSync(path.join(dataDir,rule.account+'.session')))throw Error('请先登录规则的 TG 账号');
    const python = context.pythonCommand();
    if(!python)throw Error('未找到 Python 运行环境');
    context.acquire(rule.account);
    const run = history.create(rule.account,'manual','plugin');
    run.plugin='zeroSpeakers';run.ruleId=rule.id;run.name=rule.name || '清理0发言群员';run.group=rule.group;
    run.featureProgress={phase:'preparing'};
    let finish;
    const completion = new Promise(resolve=>{finish=resolve;});
    const job={run,child:null,completion,stopRequested:false};
    active.set(run.id,job);
    try {
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      const snapshot={id:run.id,ruleId:rule.id,account:rule.account,group:rule.group,name:run.name,createdAt:run.startedAt,phase:'queued'};
      if(store)await store.write('cleanup-job:'+run.id,snapshot);
      else fs.writeFileSync(path.join(directory,run.id+'.json'),JSON.stringify(snapshot),{mode:0o600});
      await history.flush();
      await context.pause();
      if(closing || job.stopRequested || !context.canStart())throw Error('清理任务已停止');
      line(run,'启动清理0发言群员；等待执行账号在目标群发送“是”或“否”后才会清理。');
      const child=spawn(python.name,[...(python.prefix || []),'-u','cleanup_worker.py','--job',run.id],{cwd:root,env:{...process.env,...workerEnv,AUTOCHECKIN_DATA_DIR:dataDir,AUTOCHECKIN_PARENT_PIPE:'1',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8'},windowsHide:true,stdio:['pipe','pipe','pipe']});
      job.child=child;
      child.stdin.on('error',()=>{});
      for(const [stream,pipe] of [['stdout',child.stdout],['stderr',child.stderr]]) {
        let buffer='';pipe.setEncoding('utf8');
        function output(text) {
          if(stream==='stdout')try {
            const event=JSON.parse(text);
            if(event.type==='cleanup_progress') {run.featureProgress={...run.featureProgress,...event.progress};history.changed();return;}
            if(event.type==='cleanup_result') {job.result=['completed','cancelled','partial','failed'].includes(event.state) ? event.state : 'failed';return;}
            if(event.message) {line(run,event.message,event.level==='error' ? 'stderr' : 'system');return;}
          }catch{}
          line(run,text,stream);
        }
        pipe.on('data',chunk=>{buffer+=chunk;const parts=buffer.split(/\r?\n/);buffer=parts.pop();parts.filter(Boolean).forEach(output);if(buffer.length>65536){output(buffer);buffer='';}});
        pipe.on('end',()=>{if(buffer)output(buffer);});
      }
      child.on('error',error=>line(run,error.message,'stderr'));
      child.once('close',code=>{
        run.exitCode=code;run.state=job.stopRequested ? 'stopped' : code===0 ? job.result || 'completed' : 'failed';run.finishedAt=new Date().toISOString();
        if(job.stopRequested)line(run,'本次清理任务已停止；未完成的清理不会自动继续。');
        history.changed(true);active.delete(run.id);context.release(run.account);finish();
      });
      return {...run,lines:run.lines.slice(-150)};
    }catch(error) {
      run.state=job.stopRequested || closing ? 'stopped' : 'failed';run.finishedAt=new Date().toISOString();line(run,error.message,'stderr');
      history.changed(true);active.delete(run.id);context.release(rule.account);finish();throw error;
    }
  }
  async function stop(id) {
    const job=active.get(id);
    if(!job)throw Error('清理任务不存在或已经结束');
    job.stopRequested=true;job.run.state='stopping';history.changed();
    if(job.child) {
      const force=setTimeout(()=>job.child.kill('SIGKILL'),5000);force.unref();
      // EOF cancels the worker gracefully, including on Windows. The same pipe
      // closes on a server crash, so orphan workers cannot keep clearing members.
      job.child.stdin.end();await job.completion;clearTimeout(force);
    }else await job.completion;
  }
  function report(id) {
    const run=history.find(id);
    if(!run || run.plugin!=='zeroSpeakers' || !/^[a-f0-9-]{36}$/.test(id))throw Error('报告不存在或无权访问');
    const file=path.join(directory,id+'.xlsx');
    if(!fs.existsSync(file))throw Error('报告尚未生成');
    return file;
  }
  return {start,stop,view,report,async shutdown(){closing=true;await Promise.allSettled([...active.keys()].map(stop));}};
}
module.exports={createCleanupController};
