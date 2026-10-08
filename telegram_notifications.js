'use strict';
const fs = require('node:fs'), path = require('node:path');
const {randomUUID} = require('node:crypto');
const CheckinResults = require('./checkin_results');
function formatRunResult(record, accountName = record.account || '账号') {
  const summary=CheckinResults.summarize(record,record.account), {counts,items}=summary;
  const labels={completed:'已完成',partial:'部分成功',failed:'失败',stopped:'已停止',interrupted:'服务中断',startup_failed:'启动失败'};
  const icon=summary.state==='completed' ? '✅' : summary.state==='partial' || summary.state==='stopped' ? '⚠️' : '❌';
  const time=value=>Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)+28800000).toISOString().slice(0,19).replace('T',' ')+'（北京时间）' : '—';
  const account=accountName===record.account || !record.account ? accountName : accountName+'（'+record.account+'）';
  const heading=icon+' AutoCheckin · '+(summary.label==='签到未完成' ? summary.label : '签到'+(summary.label || labels[summary.state] || summary.state));
  const header=[heading,'','👤 账号：'+account,
    '⏱ 执行方式：'+(record.bot ? 'Bot 独立定时 · '+CheckinResults.botLabel(items.find(item=>CheckinResults.key(item.bot)===CheckinResults.key(record.bot)) || {bot:record.bot,note:record.botNote}) : '定时签到'),
    '结果：'+(labels[summary.state] || summary.state)];
  if(counts.total)header.push('📊 结果：共 '+counts.total+' 个 · 成功 '+counts.success+' · 超时 '+counts.timeout+' · 失败 '+counts.failed+(counts.unknown ? ' · 待确认 '+counts.unknown : '')+(counts.skipped ? ' · 跳过 '+counts.skipped : ''));
  const seconds=Math.max(0,Math.round((Date.parse(record.finishedAt)-Date.parse(record.startedAt))/1000) || 0);
  const footer=['','🕒 结束时间：'+time(record.finishedAt),'⌛ 总耗时：'+(seconds>=60 ? Math.floor(seconds/60)+' 分 '+seconds%60+' 秒' : seconds+' 秒')].join('\n');
  let content=header.join('\n'),omitted=0;
  const sections=[
    ['未完成',items.filter(item=>['timeout','failed','unknown'].includes(item.status))],
    ['签到成功',items.filter(item=>['success','already'].includes(item.status))],
    ['已跳过',items.filter(item=>item.status==='skipped')]
  ];
  for(const [title,rows] of sections) {
    if(!rows.length)continue;
    const lines=['','━━━━ '+title+' ━━━━',...rows.map(item=>CheckinResults.resultLine(item))];
    for(let i=0;i<lines.length;i++) {
      if(content.length+lines[i].length+footer.length+90>3500){if(i>=2)omitted++;continue;}
      content+='\n'+lines[i];
    }
  }
  if(omitted)content+='\n… 另有 '+omitted+' 条，请查看网页日志。';
  return content+footer;
}
async function createTelegramNotifications({dataDir,store=null,fetchImpl=fetch,now=Date.now,timeoutMs=10000,pollMs=1000}) {
  const file = path.join(dataDir,'.notifications.json');
  const saved = store ? store.read('notifications') : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : null;
  let data = {settings:{enabled:false,token:'',chatId:''},jobs:[],...(saved || {})}, queue=Promise.resolve(), timer=null, pumping=false, closed=false, activeController=null, idleResolve=null;
  async function mutate(operation) {
    const pending = queue.then(async()=>{
      const next=structuredClone(data), result=operation(next);
      next.jobs=next.jobs.filter(job=>['pending','sending'].includes(job.state)).concat(next.jobs.filter(job=>!['pending','sending'].includes(job.state)).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).slice(-50));
      if (store) await store.write('notifications',next);
      else {fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);}
      data=next;return result;
    });
    queue=pending.catch(()=>{});return pending;
  }
  function view() {
    return {enabled:data.settings.enabled,chatId:data.settings.chatId,hasToken:Boolean(data.settings.token),deliveries:data.jobs.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,20).map(job=>({id:job.id,account:job.account,kind:job.kind,state:job.state,attempts:job.attempts,createdAt:job.createdAt,finishedAt:job.finishedAt,error:job.error || ''}))};
  }
  async function update(input) {
    if (!input || typeof input.enabled !== 'boolean') throw Error('通知配置格式不正确');
    const suppliedToken=String(input.botToken || '').trim();
    const chatId=String(input.chatId || '').trim();
    if (suppliedToken && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(suppliedToken)) throw Error('通知 Bot Token 格式不正确');
    if (chatId && !/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) throw Error('接收会话请填写数字 Chat ID 或 @频道用户名');
    await mutate(next=>{
      const token=suppliedToken || next.settings.token;
      if (input.enabled && (!token || !chatId)) throw Error('请填写 Bot Token 和接收 Chat ID');
      const changed=token!==next.settings.token || chatId!==next.settings.chatId || !input.enabled;
      next.settings={enabled:input.enabled,token,chatId};
      if (changed) for(const job of next.jobs) if(job.state==='pending'){job.state='cancelled';job.finishedAt=new Date(now()).toISOString();delete job.text;}
    });return view();
  }
  async function enqueue(id,text,{account=null,kind='scheduled'}={}) {
    if (closed || !data.settings.enabled) return false;
    await mutate(next=>{
      if (!next.settings.enabled || next.jobs.some(job=>job.id===id)) return;
      if(next.jobs.filter(job=>job.state==='pending').length>=100)throw Error('通知队列已满');
      next.jobs.push({id,text:String(text).slice(0,3500),account,kind,state:'pending',attempts:0,nextAt:now(),createdAt:new Date(now()).toISOString()});
    });
    void pump();return true;
  }
  async function pump() {
    if (pumping || closed) return;
    pumping=true;
    try {
      if(data.jobs.some(job=>job.state==='sending'))await mutate(next=>{for(const job of next.jobs)if(job.state==='sending'){job.state=job.attempts>=3 ? 'failed' : 'pending';job.nextAt=now();}});
      while(!closed && data.settings.enabled) {
        const job=data.jobs.find(job=>job.state==='pending' && job.nextAt<=now());
        if(!job)break;
        const settings=await mutate(next=>{const item=next.jobs.find(item=>item.id===job.id);if(item.state!=='pending' || !next.settings.enabled)return null;item.state='sending';item.attempts++;return {...next.settings};});
        if(!settings)continue;
        let failure=null;activeController=new AbortController();
        const timeout=setTimeout(()=>activeController?.abort(),timeoutMs);
        try {
          const response=await fetchImpl('https://api.telegram.org/bot'+settings.token+'/sendMessage',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({chat_id:settings.chatId,text:job.text,link_preview_options:{is_disabled:true}}),
            signal:activeController.signal,redirect:'error'
          });
          const body=await response.json();
          if(!response.ok || body.ok!==true) {
            const code=Number(body.error_code || response.status);
            failure={retry:code===429 || code>=500,wait:Math.max(5,Math.min(300,Number(body.parameters?.retry_after) || 10)),
              message:code===401 ? 'Bot Token 无效' : code===403 ? 'Bot 无法向该会话发送消息，请检查权限或是否已启动 Bot' : code===400 ? '接收会话或消息参数无效' : 'Telegram 返回错误（'+code+'）'};
          }
        } catch {failure={retry:true,wait:10,message:'Telegram 请求超时或网络连接失败'};}
        finally {clearTimeout(timeout);activeController=null;}
        await mutate(next=>{
          const item=next.jobs.find(item=>item.id===job.id);item.error=failure?.message || '';
          if(failure?.retry && item.attempts<3 && next.settings.enabled && next.settings.token===settings.token && next.settings.chatId===settings.chatId) {
            item.state='pending';item.nextAt=now()+failure.wait*1000;
          } else {item.state=failure ? 'failed' : 'sent';item.finishedAt=new Date(now()).toISOString();delete item.text;}
        });
      }
    } catch {console.error('TG 通知状态保存失败，将在下次检查时恢复');}
    finally {pumping=false;idleResolve?.();idleResolve=null;}
  }
  // A restart can interrupt an HTTP request; retain the job for a bounded retry.
  if(data.jobs.some(job=>job.state==='sending'))await mutate(next=>{for(const job of next.jobs)if(job.state==='sending'){job.state=job.attempts>=3 ? 'failed' : 'pending';job.nextAt=now();job.error='服务重启时通知发送中断';}});
  return {
    view,update,pump,
    redact:text => data.settings.token ? String(text).split(data.settings.token).join('[已隐藏]') : String(text),
    notifyRun:(record,name)=>record.trigger==='scheduled' ? enqueue(record.id,formatRunResult(record,name),{account:record.account}) : Promise.resolve(false),
    test:async()=>{if(!data.settings.enabled)throw Error('请先保存并启用 TG 通知');return enqueue(randomUUID(),'AutoCheckin 测试通知\nTG 通知连接已配置。',{kind:'test'});},
    start(){if(!timer && !closed){timer=setInterval(()=>{void pump();},pollMs);timer.unref();void pump();}},
    async stop(){closed=true;clearInterval(timer);timer=null;activeController?.abort();if(pumping)await new Promise(resolve=>idleResolve=resolve);await queue;}
  };
}
module.exports={createTelegramNotifications,formatRunResult};
