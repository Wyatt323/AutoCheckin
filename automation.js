const { spawn } = require('node:child_process');
const path = require('node:path');

let context;
let processHandle = null;
let desired = false;
let retryTimer = null;
let stopping = null;
let state = { status: 'idle', startedAt: null, message: '尚未配置自动化规则', lines: [] };

function configure(options) { context = options; }
function getState() { return { ...state, lines: state.lines.slice(-120) }; }
function line(message, level = 'info') {
  state.lines.push({ time: new Date().toISOString(), level, message: String(message).slice(0, 1000) });
  if (state.lines.length > 300) state.lines.splice(0, state.lines.length - 300);
}

function enabledRules(config) {
  const rules = config.automations || {};
  return [...(rules.schedules || []), ...(rules.forwards || [])].filter(rule => rule.enabled !== false);
}

function start() {
  if (!context || processHandle || stopping) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  const config = context.readConfig();
  const rules = enabledRules(config);
  if (!rules.length) {
    desired = false;
    state.status = 'idle';
    state.message = '尚无启用的自动化规则';
    return;
  }
  desired = true;
  if (context.canRun && !context.canRun()) {
    state.status = 'paused';
    state.message = '签到任务运行中，自动化已暂停';
    return;
  }
  const python = context.pythonCommand();
  if (!python) {
    state.status = 'unavailable';
    state.message = '未找到 Python；安装运行环境后重启自动化';
    return;
  }
  const users = config.telegram?.users || config.users || [];
  const sessions = new Set(rules.map(rule => rule.account));
  for (const session of sessions) {
    if (!users.some(user => (user.session || user.name) === session) || !require('node:fs').existsSync(path.join(context.dataDir || context.root, `${session}.session`))) {
      state.status = 'unavailable';
      state.message = `账号 ${session} 缺少 Session 文件，请先在账号管理中登录`;
      return;
    }
  }
  state.status = 'starting';
  state.startedAt = new Date().toISOString();
  state.message = `使用 ${python.version} 启动自动化`;
  line(state.message);
  let worker;
  try {
    worker = spawn(python.name, [...(python.prefix || []), '-u', 'automation_worker.py'], {
      cwd: context.root, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    state.status = 'failed';
    state.message = error.message;
    line(error.message, 'error');
    return;
  }
  processHandle = worker;
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
        if (level === 'error') { line(part, 'error'); continue; }
        try {
          const event = JSON.parse(part);
          if (event.type === 'ready' && desired) { state.status = 'running'; state.message = event.message || '监听中'; }
          else if (event.type === 'fatal') { state.status = 'failed'; state.message = event.message || '自动化启动失败'; line(state.message, 'error'); }
          else line(event.message || part, event.level || 'info');
        } catch { line(part); }
      }
      if (buffer.length > 65536) { line(buffer, level); buffer = ''; }
    });
    pipe.on('end', () => { if (buffer && processHandle === worker) line(buffer, level); });
  }
  worker.on('error', error => { if (processHandle !== worker) return; state.status = 'failed'; state.message = error.message; line(error.message, 'error'); });
  worker.on('close', code => {
    if (processHandle !== worker) return;
    processHandle = null;
    if (!desired) {
      state.status = 'paused';
      state.message = '自动化已暂停';
      return;
    }
    state.status = 'failed';
    if (code !== 2) state.message = `自动化进程退出（代码 ${code}），15 秒后重试`;
    line(`自动化进程退出（代码 ${code}）`, 'error');
    if (code !== 2) { retryTimer = setTimeout(start, 15000); retryTimer.unref?.(); }
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
    function closed() { finish(); }
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
  start();
}

module.exports = { configure, getState, start, stop, restart };
