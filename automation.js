const { spawn } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function combineCheckinWorkers(workers) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();child.stderr = new PassThrough();
  child.exitCode = null;child.signalCode = null;
  let remaining = workers.length,failed = false;
  for(const worker of workers) {
    worker.stdout.pipe(child.stdout,{end:false});worker.stderr.pipe(child.stderr,{end:false});
    worker.on('error',error=>{failed=true;child.stderr.write('签到执行失败：'+error.message+'\n');});
    worker.once('close',code=>{
      failed ||= code!==0;
      if(--remaining===0) {
        child.exitCode=failed ? 1 : 0;child.stdout.end();child.stderr.end();child.emit('close',child.exitCode);
      }
    });
  }
  child.kill=signal=>{for(const worker of workers)if(worker.exitCode===null && worker.signalCode===null)worker.kill(signal);return true;};
  return child;
}

function createAutomation() {
  let context;
  let processHandle = null;
  let desired = false;
  let retryTimer = null;
  let stopping = null;
  let recoveryTimer = null;
  let sessionOwners = [];
  let stableSince = null;
  const accountHealth = new Map();
  const checkins = new Map();
  let checkinAccounts = [];
  let state = { status: 'idle', startedAt: null, message: '尚未配置自动化规则', lines: [], planned: [], redPackets: Object.create(null) };
  let lastPacketNotice = '';
  state.retryAttempts = 0;
  state.autoRestartBlocked = false;
  state.lastHeartbeatAt = null;

  function configure(options) { context = options; }
  function getState() {
    // Read the committed snapshot, including while paused/unavailable after restart.
    let plans = [];
    if (context?.store && ['starting','running'].includes(state.status)) return {...state, planned:state.planned, lines:state.lines.slice(-120)};
    try {
      const persisted = context.store ? context.store.read('automation-state') || {} : JSON.parse(require('node:fs').readFileSync(path.join(context.dataDir || context.root, '.automation-state.json'), 'utf8'));
      const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      const rules = enabledRules(context.readConfig());
      plans = Object.entries(persisted.planned || {}).filter(([key, plan]) => plan.date === today && rules.some(rule => rule.account === plan.account && rule.id === plan.ruleId && rule.timeMode === 'random' && (persisted.claimed?.[key] || JSON.stringify(plan.signature) === JSON.stringify([rule.rangeStart, rule.rangeEnd])))).map(([, {account, ruleId, date, time}]) => ({account, ruleId, date, time}));
    } catch {}
    return { ...state, planned: plans, lines: state.lines.slice(-120) };
  }
  function line(message, level = 'info', metadata = {}) {
    const entry = { time: new Date().toISOString(), level, message: String(message).slice(0, 1000), account:metadata.account, category:metadata.category, ruleId:metadata.ruleId, state:metadata.state };
    state.lines.push(entry);
    context?.onEvent?.(entry);
    if (state.lines.length > 300) state.lines.splice(0, state.lines.length - 300);
  }

  function enabledRules(config) {
    const rules = config.automations || {};
    return [...(rules.schedules || []), ...(rules.forwards || []), ...(rules.forwardPins || []), ...(rules.redPackets || [])].filter(rule => rule.enabled !== false);
  }

  function finishCheckin(id, code, message) {
    const job=checkins.get(id);
    if(!job)return;
    checkins.delete(id);clearTimeout(job.timeout);
    if(message)job.child.stderr.write(message+'\n');
    job.child.exitCode=code;job.child.stdout.end();job.child.stderr.end();job.child.emit('close',code);
  }

  function submitCheckin(job) {
    if(job.sent || processHandle!==job.worker || state.status!=='running')return;
    if(!job.accounts.every(account=>checkinAccounts.includes(account))) {
      finishCheckin(job.id,1,'监听账号未连接，无法复用连接签到；监听继续运行');return;
    }
    job.sent=true;clearTimeout(job.timeout);
    job.worker.stdin.write(JSON.stringify({type:'checkin',id:job.id,accounts:job.accounts,bot:job.bot,scheduled:job.scheduled})+'\n',error=>{
      if(error)job.worker.kill('SIGTERM'); // Completion waits for close, preserving Session ownership.
    });
  }

  function runCheckin({id,accounts,bot=null,scheduled=false}) {
    if(!processHandle || !['starting','running'].includes(state.status) || !accounts.every(account=>sessionOwners.includes(account)))throw Error('自动化连接未就绪，请稍后执行签到');
    if(checkins.has(id) || [...checkins.values()].some(job=>job.accounts.some(account=>accounts.includes(account))))throw Error('此账号已有签到任务');
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.exitCode=null;child.signalCode=null;
    const job={id,accounts,bot,scheduled,child,worker:processHandle,sent:false,timeout:null,cancelling:false};
    checkins.set(id,job);
    child.kill=signal=>{
      if(!checkins.has(id))return false;
      if(!job.sent){finishCheckin(id,130);return true;}
      if(signal==='SIGKILL'){job.worker.kill('SIGKILL');return true;}
      if(!job.cancelling) {
        job.cancelling=true;
        job.worker.stdin.write(JSON.stringify({type:'cancel_checkin',id})+'\n',error=>{if(error)job.worker.kill('SIGTERM');});
        job.timeout=setTimeout(()=>{if(checkins.has(id))job.worker.kill('SIGTERM');},15000);job.timeout.unref?.();
      }
      return true;
    };
    // Delay delivery so the web runner can attach all stdout/close listeners first.
    queueMicrotask(()=>{
      if(!checkins.has(id))return;
      if(state.status==='running')submitCheckin(job);
      else {job.timeout=setTimeout(()=>finishCheckin(id,1,'等待监听连接就绪超时，本次未执行签到'),90000);job.timeout.unref?.();}
    });
    return child;
  }

  function packetNotice(message, level = 'info', runState = 'running') {
    const rules=(context?.readConfig().automations?.redPackets || []).filter(rule=>rule.enabled!==false);
    const signature=JSON.stringify([message,level,runState,rules.map(rule=>rule.id)]);
    if(signature===lastPacketNotice)return;
    lastPacketNotice=signature;
    for(const rule of rules)line(`[${rule.name || rule.id}] ${message}`,level,{account:rule.account,category:'red_packet',ruleId:rule.id,state:runState});
  }

  function start() {
    if (!context || processHandle || stopping || retryTimer) return;
    if(state.autoRestartBlocked)return;
    state.retryLimit=context.retryLimit?.() ?? 3;
    clearTimeout(retryTimer);
    retryTimer = null;
    const config = context.readConfig();
    const rules = enabledRules(config);
    try {
      if (!context.store) {
      const fs = require('node:fs');
      const file = path.join(context.dataDir || context.root, '.automation-state.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const plans = data.planned || {};
      const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      const retained = Object.fromEntries(Object.entries(plans).filter(([key, plan]) => plan.date === today && rules.some(rule => rule.account === plan.account && rule.id === plan.ruleId && rule.timeMode === 'random' && (data.claimed?.[key] || JSON.stringify(plan.signature) === JSON.stringify([rule.rangeStart, rule.rangeEnd])))));
      if (JSON.stringify(plans) !== JSON.stringify(retained)) {
        data.planned = retained;
        fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', {mode:0o600});
        fs.renameSync(file + '.tmp', file);
      }
      }
    } catch (error) { if (error.code !== 'ENOENT') line(`清理定时计划失败：${error.message}`, 'error'); }
    state.planned = state.planned.filter(plan => rules.some(rule => rule.account === plan.account && rule.id === plan.ruleId && rule.timeMode === 'random'));
    if (!rules.length) {
      desired = false;
      state.status = 'idle';
      state.message = '尚无启用的自动化规则';
      return;
    }
    desired = true;
    if (context.canRun && !context.canRun()) {
      state.status = 'paused';
      state.message = '登录、配置变更或其他账号任务占用连接，自动化暂未启动';
      packetNotice(state.message,'info','stopped');
      return;
    }
    const python = context.pythonCommand();
    if (!python) {
      state.status = 'unavailable';
      state.message = '未找到 Python；安装运行环境后重启自动化';
      packetNotice(state.message,'error','failed');
      return;
    }
    const users = config.telegram?.users || config.users || [];
    const sessions = new Set(rules.map(rule => rule.account));
    for (const session of sessions) {
      if (!users.some(user => (user.session || user.name) === session) || !require('node:fs').existsSync(path.join(context.dataDir || context.root, `${session}.session`))) {
        state.status = 'unavailable';
        state.message = `账号 ${session} 缺少 Session 文件，请先在账号管理中登录`;
        packetNotice(state.message,'error','failed');
        return;
      }
    }
    state.status = 'starting';
    state.redPackets = Object.create(null);
    state.startedAt = new Date().toISOString();
    state.lastHeartbeatAt = state.startedAt;
    state.message = `使用 ${python.version} 启动自动化`;
    line(state.message);
    packetNotice(`${state.message}，正在连接账号与监听群组`);
    let worker;
    try {
      worker = spawn(python.name, [...(python.prefix || []), '-u', 'automation_worker.py'], {
        cwd: context.root, env: { ...process.env, ...(context.workerEnv || {}), AUTOCHECKIN_CONTROL:'1', AUTOCHECKIN_DATA_DIR:context.dataDir || context.root, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      state.status = 'failed';
      state.message = error.message;
      line(error.message, 'error');
      packetNotice(`自动化进程无法启动：${error.message}`,'error','failed');
      return;
    }
    processHandle = worker;
    sessionOwners = [...sessions];
    accountHealth.clear();
    checkinAccounts=[];
    stableSince = null;
    worker.stdin?.on('error',()=>{});
    for (const [level, pipe] of [['info', worker.stdout], ['error', worker.stderr]]) {
      let buffer = '';
      pipe.setEncoding('utf8');
      pipe.on('data', chunk => {
        if (processHandle !== worker) return;
        buffer += chunk;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        for (const part of parts) {
          if (!part) continue;
          if (level === 'error') { line(part, 'error'); packetNotice(`自动化进程错误：${part}`,'error','failed'); continue; }
          try {
            const event = JSON.parse(part);
            if(event.type==='checkin') {
              const job=checkins.get(event.requestId);
              if(!job || job.worker!==worker || !event.event || typeof event.event!=='object')continue;
              if(event.event.type==='finished')finishCheckin(job.id,[0,1,130].includes(event.event.code) ? event.event.code : 1);
              else if(['checkin_log','account_result','bot_result','health'].includes(event.event.type) && (!event.event.account || job.accounts.includes(event.event.account)))job.child.stdout.write(JSON.stringify(event.event)+'\n');
            }
            else if(event.type==='health') {
              state.lastHeartbeatAt=new Date().toISOString();
              if(sessionOwners.includes(event.account))accountHealth.set(event.account,event.status);
              context.onHealth?.(event);
              for(const job of checkins.values())if(job.worker===worker && (!event.account || job.accounts.includes(event.account)))job.child.stdout.write(JSON.stringify({...event,source:'automation'})+'\n');
              if(state.status==='running' && sessionOwners.every(account=>accountHealth.get(account)==='online')) {
                stableSince ??= Date.now();
                if(Date.now()-stableSince>=120000)state.retryAttempts=0;
              } else stableSince=null;
            }
            else if (event.type === 'planned') { state.planned = Array.isArray(event.planned) ? event.planned.map(({account, ruleId, date, time}) => ({account, ruleId, date, time})) : []; }
            else if (event.type === 'red_packet_status' && typeof event.account === 'string' && Array.isArray(event.groups)) { state.redPackets[event.account] = {groups:event.groups}; }
            else if (event.type === 'ready' && desired) {
              state.status = 'running';state.runningSince=new Date().toISOString();state.message = event.message || '监听中';
              checkinAccounts=Array.isArray(event.checkinAccounts) ? event.checkinAccounts.filter(account=>sessionOwners.includes(account)) : [];
              for(const job of checkins.values())submitCheckin(job);
            }
            else if (event.type === 'fatal') { state.status = 'failed'; state.message = event.message || '自动化启动失败'; line(state.message, 'error'); packetNotice(state.message,'error','failed'); }
            else line(event.message || part, event.level || 'info', event);
          } catch { line(part); }
        }
        if (buffer.length > 65536) { line(buffer, level); buffer = ''; }
      });
      pipe.on('end', () => { if (buffer && processHandle === worker) line(buffer, level); });
    }
    worker.on('error', error => { if (processHandle !== worker) return; state.status = 'failed'; state.message = error.message; line(error.message, 'error'); packetNotice(`自动化进程错误：${error.message}`,'error','failed'); });
    worker.on('close', code => {
      if (processHandle !== worker) return;
      clearTimeout(recoveryTimer);recoveryTimer=null;
      processHandle = null;
      sessionOwners = [];
      checkinAccounts=[];
      for(const job of [...checkins.values()])if(job.worker===worker)finishCheckin(job.id,1,'监听进程已退出，本次签到中断；不会自动重复发送签到消息');
      if (!desired) {
        state.status = 'paused';
        state.message = '自动化已暂停';
        return;
      }
      state.status = 'failed';
      if (code !== 2) state.message = `自动化进程退出（代码 ${code}），15 秒后重试`;
      line(`自动化进程退出（代码 ${code}）`, 'error');
      packetNotice(state.message || `自动化进程退出（代码 ${code}）`,'error','failed');
      if (code !== 2) {
        state.retryLimit=context.retryLimit?.() ?? 3;
        if(state.retryAttempts>=state.retryLimit) {
          state.autoRestartBlocked=true;
          state.message=`自动化连续异常，已达到 ${state.retryLimit} 次恢复上限；请检查后手动重启`;
          packetNotice(state.message,'error','failed');
        } else {state.retryAttempts++;retryTimer = setTimeout(()=>{retryTimer=null;start();}, 15000); retryTimer.unref?.();}
      }
    });
  }

  function stop() {
    desired = false;
    clearTimeout(retryTimer);
    retryTimer = null;
    if (stopping) return stopping;
    const worker = processHandle;
    if (!worker) {
      state.status = 'paused';
      state.message = '自动化已暂停';
      return Promise.resolve();
    }
    state.status = 'stopping';
    state.message = '自动化正在停止';
    packetNotice('红包监听暂停，恢复后重新连接','info','stopped');
    const graceMs = context.stopTimeoutMs ?? 5000;
    stopping = new Promise((resolve, reject) => {
      let escalation;
      let deadline;
      function finish(error) {
        clearTimeout(escalation);
        clearTimeout(deadline);
        worker.removeListener('close', closed);
        // Never release session ownership until close confirms that the worker exited.
        stopping = null;
        if (error) { state.status = 'failed'; state.message = error.message; reject(error); }
        else resolve();
      }
      function closed() {
        if (context.store) context.store.refresh('automation-state').then(() => finish(), () => finish(new Error('读取自动化状态失败')));
        else finish();
      }
      worker.once('close', closed);
      escalation = setTimeout(() => {
        line('自动化未及时退出，发送 SIGKILL', 'error');
        try { worker.kill('SIGKILL'); } catch (error) { line(error.message, 'error'); }
        deadline = setTimeout(() => finish(new Error('自动化进程停止超时，拒绝并行启动')), graceMs);
      }, graceMs);
      try { worker.kill('SIGTERM'); } catch (error) { line(error.message, 'error'); }
    });
    return stopping;
  }

  async function restart() {
    await stop();
    state.retryAttempts=0;state.autoRestartBlocked=false;
    start();
  }

  function recover() {
    if(!processHandle || state.status!=='running' || stopping || checkins.size)return;
    state.status='recovering';state.message='健康检查发现连接异常，正在恢复自动化';
    const worker=processHandle;
    recoveryTimer=setTimeout(()=>{if(processHandle===worker)worker.kill('SIGKILL');},5000);
    recoveryTimer.unref?.();
    worker.kill('SIGTERM');
  }

  return { configure, getState, start, stop, restart, recover, runCheckin, ownedAccounts:()=>sessionOwners.slice() };
}
module.exports = { ...createAutomation(), createAutomation, combineCheckinWorkers };
