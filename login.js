const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { resolveCredentials } = require('./telegram_credentials');

const LOGIN_PHASES = Object.freeze({
  dependencies:'加载登录组件', configuration:'读取账号配置', credentials:'检查 API 凭据',
  proxy:'检查出口代理', session:'打开登录会话', connect:'连接 Telegram',
  authorization:'检查登录状态', qr:'获取登录二维码', qr_image:'生成二维码图片',
  scan:'等待扫码确认', password_input:'等待两步密码', password:'验证两步密码', profile:'同步账号资料', startup:'启动登录组件'
});
// Never forward worker exception messages: they can include API hashes or QR tokens.
const LOGIN_ERRORS = Object.freeze({
  api_invalid:['Telegram 拒绝了 API 凭据', '请检查「全局设置」中的 API ID 与 API Hash 是否属于同一组；未自定义时请管理员检查全局 API。'],
  api_restricted:['当前 Telegram API 暂时受限', '请稍后重试，或在全局设置中使用你自己的 Telegram API。', false],
  credentials_missing:['缺少有效的 Telegram API 凭据', '请在「全局设置」配置 API ID 与 API Hash，或请管理员检查默认配置。'],
  proxy_config:['出口代理配置读取失败', '请检查账号选择的代理是否仍存在，以及代理地址、端口、协议和认证配置。'],
  proxy_unreachable:['无法通过所选代理连接 Telegram', '请检查账号出口代理是否可用，并确认代理允许连接 Telegram；可先在全局设置测试该代理。'],
  network_error:['连接 Telegram 失败', '请检查部署服务器的网络；需要代理时，在全局设置添加代理并为此账号选择出口。'],
  connection_timeout:['连接 Telegram 超时', '请检查部署服务器的网络和账号出口代理，确认能够访问 Telegram 后重试。'],
  dependency_missing:['登录组件或依赖未正确安装', 'Docker 部署请重新构建镜像；本机部署请在项目虚拟环境安装 requirements.txt 中的依赖。', false],
  qr_render_failed:['无法生成登录二维码图片', '请检查 Python 环境中的 qrcode 和 Pillow 依赖；Docker 部署可重新构建镜像。', false],
  config_unavailable:['无法读取账号配置', '请检查数据库连接或配置文件，确认账号已保存后重试。'],
  storage_permission:['登录数据目录没有读写权限', '请检查 Docker 数据卷或本机数据目录权限，修复后重新登录。', false],
  session_busy:['此账号的登录会话正在被占用', '请确认没有另一个 AutoCheckin 实例使用同一 Session，待占用结束后重试。'],
  session_storage:['无法读取账号登录会话', '请检查 Session 文件及数据卷是否损坏，先备份数据再处理；程序不会自动删除会话。', false],
  session_invalid:['Telegram 登录会话已失效', '请在 Telegram 官方客户端核对设备与账号状态，确认没有其他实例共用此 Session 后重试。'],
  account_unavailable:['Telegram 返回账号已停用或被封禁', '请在 Telegram 官方客户端确认账号状态。', false],
  rate_limited:['Telegram 要求暂时等待', '请等待 Telegram 指定的时间结束后再尝试登录。', false],
  password_invalid:['两步验证密码连续输入错误', '请确认 Telegram 两步验证密码，然后重新扫码登录。'],
  password_timeout:['等待两步验证密码超时', '请重新扫码，并在两分钟内输入 Telegram 两步验证密码。'],
  qr_expired:['登录二维码已过期或失效', '请重新获取二维码，使用 Telegram 手机客户端扫描最新二维码。'],
  qr_timeout:['等待扫码确认超时', '请重新获取二维码，并在 Telegram 手机客户端确认登录。'],
  login_timeout:['登录等待超时', '请检查网络和代理后重试；扫码后请及时确认并输入两步验证密码。'],
  login_required:['当前账号尚未登录 Telegram', '请先扫码登录，再同步账号资料。'],
  telegram_unavailable:['Telegram 服务暂时无法响应', '请稍后重试，并检查账号出口网络。'],
  process_exited:['登录进程提前退出', '请检查 Python 运行环境及容器运行状态后重试。'],
  runtime_missing:['无法启动 Python 登录组件', '请检查 Python 路径与运行权限；Docker 部署可重新构建镜像。', false],
  invalid_response:['登录组件返回了无效响应', '请确认前后端版本一致；Docker 部署请重新构建镜像。'],
  unknown:['Telegram 登录未完成', '请记录下方错误代码和失败阶段，检查部署环境后重试。']
});

function createLoginController({ workerEnv = {}, root, dataDir, readConfig, pythonCommand, isBusy, stopAutomation, resumeAutomation, onComplete = null, spawnWorker = spawn, timeoutMs = 490000 }) {
  let worker = null, pending = false, timer = null, killTimer = null, finishing = null;
  let state = { state: 'idle', active: false };
  const active = () => pending || !!worker;
  const status = () => ({ ...state, active: active() });
  function fail(code, event = {}) {
    code = typeof code === 'string' && Object.hasOwn(LOGIN_ERRORS, code) ? code : 'unknown';
    const [message, hint, retryable = true] = LOGIN_ERRORS[code];
    const phase = typeof event.phase === 'string' && Object.hasOwn(LOGIN_PHASES, event.phase) ? event.phase : state.phase;
    state = { ...state, state:'error', errorCode:code, message, hint, retryable, phase, phaseLabel:LOGIN_PHASES[phase] || '' };
    if (code === 'rate_limited' && Number.isSafeInteger(event.retryAfterSeconds) && event.retryAfterSeconds > 0 && event.retryAfterSeconds <= 2147483647) {
      state.retryAfterSeconds = event.retryAfterSeconds;
      state.hint = `Telegram 要求等待 ${event.retryAfterSeconds} 秒，请在等待结束后再登录。`;
    }
    delete state.png; delete state.expiresAt;
  }
  function check(id) {
    if (id !== state.id) throw new Error('登录任务已变化，请刷新');
  }
  async function start(account, { profileOnly = false } = {}) {
    if (active() || isBusy()) throw new Error('有任务正在运行，请稍后登录');
    const config = readConfig();
    const users = config.telegram?.users || config.users || [];
    const user = users.find(user => (user.session || user.name) === account);
    if (!user || typeof account !== 'string' || !/^[\w.-]+$/.test(account) || ['.', '..'].includes(account)) throw new Error('账号不存在或 Session 无效');
    if (profileOnly && !fs.existsSync(path.join(dataDir, `${account}.session`))) throw new Error('请先登录 Telegram，再同步资料');
    resolveCredentials(config, user);
    const python = pythonCommand();
    if (!python) throw new Error('未找到 Python');
    pending = true;
    state = { id: randomUUID(), account, mode: profileOnly ? 'profile' : 'login', state: 'starting', message: profileOnly ? '正在同步 Telegram 资料' : '正在准备登录' };
    try {
      await stopAutomation();
      if (state.state === 'cancelled' || isBusy()) throw new Error('登录已取消或服务忙碌');
      worker = spawnWorker(python.name, [...python.prefix, '-u', path.join(root, 'login_worker.py'), account, ...(profileOnly ? ['--profile-only'] : [])], {
        cwd: root, env: { ...process.env, ...workerEnv, AUTOCHECKIN_DATA_DIR: dataDir, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
      const current = worker;
      let buffer = '', finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(killTimer);
        if (!['success', 'error', 'cancelled'].includes(state.state)) fail('process_exited');
        delete state.png; delete state.expiresAt;
        if (onComplete && state.state === 'success') {
          try { await onComplete(account); }
          catch { state.message = 'Telegram 已登录，资料刷新失败，请稍后同步资料'; }
        }
        worker = null;
        resumeAutomation();
      };
      current.stdout.setEncoding('utf8');
      current.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 512 * 1024) { fail('invalid_response'); current.kill(); buffer = ''; return; }
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (['success', 'error', 'cancelled'].includes(state.state)) continue;
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (!event || typeof event !== 'object') continue;
          if (event.type === 'progress' && typeof event.phase === 'string' && Object.hasOwn(LOGIN_PHASES, event.phase)) {
            state = { ...state, state:'starting', phase:event.phase, phaseLabel:LOGIN_PHASES[event.phase], message:`正在${LOGIN_PHASES[event.phase]}…` };
            delete state.png; delete state.expiresAt;
          } else if (event.type === 'QR' && typeof event.png === 'string' && event.png.length < 400000 && /^[A-Za-z0-9+/=]+$/.test(event.png)) {
            state = { ...state, state: 'qr', phase:'scan', phaseLabel:LOGIN_PHASES.scan, png: event.png, expiresAt: event.expiresAt, message: '用 Telegram 手机客户端扫描二维码' };
          } else if (event.type === 'password_required') {
            state = { ...state, state: 'password_required', phase:'password', phaseLabel:LOGIN_PHASES.password, message: event.invalid ? '密码错误，请重试' : '请输入 Telegram 两步验证密码' }; delete state.png; delete state.expiresAt;
          } else if (event.type === 'error') {
            fail(event.code, event);
          } else if (event.type === 'success') {
            state = { ...state, state:'success', message:profileOnly ? 'Telegram 资料已同步' : 'Telegram 登录成功' }; delete state.png; delete state.expiresAt;
          }
        }
      });
      // Deliberately discard stderr; never expose Telegram URLs, hashes or passwords.
      current.stderr.resume();
      current.stdin.on('error', () => {});
      current.on('error', () => { if (!['success','error','cancelled'].includes(state.state)) fail('runtime_missing'); });
      current.on('close', () => { const completion = finish(); finishing = completion; completion.finally(() => { if (finishing === completion) finishing = null; }); });
      timer = setTimeout(() => { fail('login_timeout'); terminate(); }, profileOnly ? Math.min(timeoutMs, 90000) : timeoutMs);
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
    if (finishing) { await finishing; return; }
    if (!active()) return;
    cancel(state.id);
    if (worker) await new Promise(resolve => worker.once('close', resolve));
    if (finishing) await finishing;
  }
  return { start, status, active, password, cancel, shutdown };
}
module.exports = { createLoginController };
