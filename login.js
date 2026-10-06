const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { resolveCredentials } = require('./telegram_credentials');

function createLoginController({ root, dataDir, readConfig, pythonCommand, isBusy, stopAutomation, resumeAutomation, spawnWorker = spawn, timeoutMs = 490000 }) {
  let worker = null, pending = false, timer = null, killTimer = null;
  let state = { state: 'idle', active: false };
  const active = () => pending || !!worker;
  const status = () => ({ ...state, active: active() });
  function check(id) {
    if (id !== state.id) throw new Error('登录任务已变化，请刷新');
  }
  async function start(account) {
    if (active() || isBusy()) throw new Error('有任务正在运行，请稍后登录');
    const config = readConfig();
    const users = config.telegram?.users || config.users || [];
    const user = users.find(user => (user.session || user.name) === account);
    if (!user || typeof account !== 'string' || !/^[\w.-]+$/.test(account) || ['.', '..'].includes(account)) throw new Error('账号不存在或 Session 无效');
    resolveCredentials(config, user);
    const python = pythonCommand();
    if (!python) throw new Error('未找到 Python');
    pending = true;
    state = { id: randomUUID(), account, state: 'starting', message: '正在准备登录' };
    try {
      await stopAutomation();
      if (state.state === 'cancelled' || isBusy()) throw new Error('登录已取消或服务忙碌');
      worker = spawnWorker(python.name, [...python.prefix, '-u', path.join(root, 'login_worker.py'), account], {
        cwd: root, env: { ...process.env, AUTOCHECKIN_DATA_DIR: dataDir, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
      const current = worker;
      let buffer = '', finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(killTimer);
        if (!['success', 'error', 'cancelled'].includes(state.state)) state = { ...state, state: 'error', message: '登录进程已退出，请重试' };
        delete state.png; delete state.expiresAt;
        worker = null;
        resumeAutomation();
      };
      current.stdout.setEncoding('utf8');
      current.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 512 * 1024) { state.state = 'error'; state.message = '登录进程响应无效'; current.kill(); buffer = ''; return; }
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (state.state === 'cancelled') continue;
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'QR' && typeof event.png === 'string' && event.png.length < 400000 && /^[A-Za-z0-9+/=]+$/.test(event.png)) {
            state = { ...state, state: 'qr', png: event.png, expiresAt: event.expiresAt, message: '用 Telegram 手机客户端扫描二维码' };
          } else if (event.type === 'password_required') {
            state = { ...state, state: 'password_required', message: event.invalid ? '密码错误，请重试' : '请输入 Telegram 两步验证密码' }; delete state.png;
          } else if (event.type === 'success' || event.type === 'error') {
            state = { ...state, state: event.type, message: event.type === 'success' ? 'Telegram 登录成功' : '登录失败或超时，请检查凭据和网络后重试' }; delete state.png;
          }
        }
      });
      // Deliberately discard stderr; never expose Telegram URLs, hashes or passwords.
      current.stderr.resume();
      current.stdin.on('error', () => {});
      current.on('error', () => { state.state = 'error'; state.message = '无法启动登录进程'; });
      current.on('close', finish);
      timer = setTimeout(() => { state.state = 'error'; state.message = '登录超时，请重试'; terminate(); }, timeoutMs);
      timer.unref?.();
    } catch (error) {
      if (state.state !== 'cancelled') state = { ...state, state: 'error', message: '无法启动登录，请重试' };
      throw error;
    } finally { pending = false; if (!worker) resumeAutomation(); }
    return status();
  }
  function terminate() {
    if (!worker) return;
    const current = worker;
    current.kill('SIGTERM');
    killTimer = setTimeout(() => { if (worker === current) current.kill('SIGKILL'); }, 3000);
    killTimer.unref?.();
  }
  function password(id, password) {
    check(id);
    if (!worker || state.state !== 'password_required') throw new Error('当前不需要密码');
    if (typeof password !== 'string' || !password.length || password.length > 256) throw new Error('密码长度须为 1–256 字符');
    worker.stdin.write(JSON.stringify({ password }) + '\n');
    state.state = 'verifying'; state.message = '正在验证密码';
    return status();
  }
  function cancel(id) {
    check(id);
    if (active()) {
      state.state = 'cancelled'; state.message = '登录已取消'; delete state.png; delete state.expiresAt;
      terminate();
    }
    return status();
  }
  async function shutdown() {
    if (!active()) return;
    cancel(state.id);
    if (worker) await new Promise(resolve => worker.once('close', resolve));
  }
  return { start, status, active, password, cancel, shutdown };
}
module.exports = { createLoginController };
