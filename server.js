const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const automation = require('./automation');
const { createScheduler } = require('./checkin_scheduler');
const { createLoginController } = require('./login');

const ROOT = __dirname;
const DATA_ROOT = path.resolve(process.env.AUTOCHECKIN_DATA_DIR || ROOT);
const PUBLIC = path.join(ROOT, 'public');
const CONFIG = path.join(DATA_ROOT, 'config.json');
if (!fs.existsSync(CONFIG)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(CONFIG, fs.readFileSync(path.join(ROOT, 'config.example.json')), { mode: 0o600 });
}
const HOST = process.env.BIND_HOST || '127.0.0.1';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8765);
const MAX_BODY = 256 * 1024;
const MAX_LINES = 800;
let child = null;
let runStarting = false;
let run = { state: 'idle', startedAt: null, finishedAt: null, exitCode: null, lines: [] };

function readConfig() {
  const raw = fs.readFileSync(CONFIG, 'utf8');
  try { return JSON.parse(raw); } catch {}
  // Legacy configs allow full-line comments and trailing commas, not inside strings.
  const text = raw.split(/\r?\n/).filter(line => !line.trimStart().startsWith('#')).join('\n');
  let output = '', quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!quoted && char === ',' && /^\s*[}\]]/.test(text.slice(index + 1))) continue;
    output += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return JSON.parse(output);
}

function viewConfig(config) {
  const telegram = config.telegram || {};
  const ai = config.ai || {};
  const parseBots = (scope, notes) => {
    const bots = [];
    const add = (name, mode, command = '/sign') => {
      name = String(name || '').trim();
      if (name && !bots.some(item => item.name.toLowerCase() === name.toLowerCase())) bots.push({ name, mode, command, note: String(notes[name] || '') });
    };
    (scope.bots || []).forEach(name => add(name, 'button'));
    ((scope.bot_groups || {}).button || []).forEach(name => add(name, 'button'));
    ((scope.bot_groups || {}).command || []).forEach(item => {
      if (typeof item === 'string') add(item, 'command');
      else {
        (item.bots || []).forEach(name => add(name, 'command', item.command));
        add(item.bot, 'command', item.command);
      }
    });
    return bots;
  };
  return {
    users: (telegram.users || config.users || []).map((user, sourceIndex) => ({
      sourceIndex, name: user.name || '', session: user.session || user.name || '',
      apiId: user.api_id || '', hasApiHash: Boolean(user.api_hash),
      sessionReady: fs.existsSync(path.join(DATA_ROOT, `${user.session || user.name}.session`)),
      dialogFolder: user.dialog_folder ?? telegram.dialog_folder ?? '',
      bots: parseBots(('bots' in user || 'bot_groups' in user) ? user : config, user.bot_notes || config.bot_notes || {}),
      checkinSchedules: Array.isArray(user.checkin_schedules) ? user.checkin_schedules : []
    })),
    automations: {
      schedules: Array.isArray(config.automations?.schedules) ? config.automations.schedules : [],
      forwards: Array.isArray(config.automations?.forwards) ? config.automations.forwards : []
    },
    model: ai.model || '',
    providers: (ai.providers || [{ name: 'default', api_key: ai.api_key, base_url: ai.base_url }]).map((provider, sourceIndex) => ({
      sourceIndex, name: provider.name || '', baseUrl: provider.base_url || '', hasApiKey: Boolean(provider.api_key)
    }))
  };
}

function nonempty(value, label, max = 200) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(`${label}不能为空或过长`);
  return text;
}

function chatRef(value, label) {
  const text = nonempty(value, label, 120);
  if (/^https:\/\/t\.me\/[A-Za-z0-9_]{5,}\/?$/i.test(text)) return `@${text.split('/').filter(Boolean).at(-1)}`;
  if (/^@[A-Za-z0-9_]{5,}$/.test(text) || /^-?\d+$/.test(text)) return text;
  throw new Error(`${label}须填写 @用户名、数字会话 ID 或公开 t.me 链接`);
}

function validateAutomations(input, users) {
  const schedules = input?.schedules || [];
  const forwards = input?.forwards || [];
  if (!Array.isArray(schedules) || !Array.isArray(forwards) || schedules.length > 100 || forwards.length > 100) throw new Error('自动化规则格式不正确或数量过多');
  const sessions = new Set(users.map(user => user.session));
  const ids = new Set();
  const idFor = (item, label) => {
    const id = nonempty(item.id, `${label} ID`, 100);
    if (!/^[A-Za-z0-9_-]{8,}$/.test(id) || ids.has(id)) throw new Error(`${label} ID 无效或重复`);
    ids.add(id);
    return id;
  };
  const accountFor = (item, label) => {
    const account = nonempty(item.account, `${label} 账号`, 100);
    if (!sessions.has(account)) throw new Error(`${label} 账号不存在`);
    return account;
  };
  const normalizedSchedules = schedules.map((item, index) => {
    const label = `定时消息 ${index + 1}`;
    const repeat = item.repeat === 'daily' ? 'daily' : item.repeat === 'once' ? 'once' : null;
    if (!repeat) throw new Error(`${label} 的时间类型无效`);
    const time = nonempty(item.time, `${label} 时间`, 30);
    if (repeat === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${label} 的每日时间无效`);
    if (repeat === 'once' && !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${label} 的发送时间无效`);
    if (repeat === 'once') {
      const parsed = new Date(`${time}:00+08:00`);
      if (Number.isNaN(parsed.getTime()) || new Date(parsed.getTime() + 8 * 3600000).toISOString().slice(0, 16) !== time) throw new Error(`${label} 的日期无效`);
    }
    const message = nonempty(item.message, `${label} 内容`, 4000);
    return { id: idFor(item, label), enabled: item.enabled !== false, account: accountFor(item, label), target: chatRef(item.target, `${label} 目标`), repeat, time, message };
  });
  const normalizedForwards = forwards.map((item, index) => {
    const label = `转发规则 ${index + 1}`;
    const source = chatRef(item.source, `${label} 来源`);
    const target = chatRef(item.target, `${label} 目标`);
    if (source.toLowerCase() === target.toLowerCase()) throw new Error(`${label} 的来源和目标不能相同`);
    return { id: idFor(item, label), enabled: item.enabled !== false, account: accountFor(item, label), source, target };
  });
  const links = new Map();
  for (const rule of normalizedForwards.filter(rule => rule.enabled)) {
    const from = `${rule.account}:${rule.source.toLowerCase()}`;
    const to = `${rule.account}:${rule.target.toLowerCase()}`;
    links.set(from, [...(links.get(from) || []), to]);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) throw new Error('转发规则存在循环，请调整来源和目标');
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of links.get(node) || []) visit(next);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of links.keys()) visit(node);
  return { schedules: normalizedSchedules, forwards: normalizedForwards };
}

function validateCheckinSchedules(input, name, botCount) {
  if (!Array.isArray(input) || input.length > 30) throw new Error(`账号 ${name} 的定时任务过多或格式不正确`);
  const ids = new Set();
  return input.map((item, index) => {
    const label = `账号 ${name} 的定时任务 ${index + 1}`;
    const id = nonempty(item.id, `${label} ID`, 100);
    if (!/^[A-Za-z0-9_-]{8,}$/.test(id) || ids.has(id)) throw new Error(`${label} ID 无效或重复`);
    ids.add(id);
    const repeat = item.repeat;
    const time = nonempty(item.time, `${label} 时间`, 30);
    if (repeat === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${label} 的每日时间无效`);
    if (repeat === 'once') {
      if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${label} 的执行时间无效`);
      const parsed = new Date(`${time}:00+08:00`);
      if (Number.isNaN(parsed.getTime()) || new Date(parsed.getTime() + 8 * 3600000).toISOString().slice(0, 16) !== time) throw new Error(`${label} 的日期无效`);
    }
    if (!['once', 'daily'].includes(repeat)) throw new Error(`${label} 的频率无效`);
    if (item.enabled !== false && !botCount) throw new Error(`${label} 已启用，请先添加此账号的签到 Bot`);
    return { id, enabled: item.enabled !== false, repeat, time };
  });
}

function saveConfig(input) {
  if (!Array.isArray(input.users) || !Array.isArray(input.providers)) throw new Error('配置格式不正确');
  if (input.users.length > 30 || input.providers.length > 20) throw new Error('配置条目过多');
  const original = readConfig();
  const oldUsers = original.telegram?.users || original.users || [];
  const oldProviders = original.ai?.providers || [{ api_key: original.ai?.api_key }];
  const seenSessions = new Set();
  const users = input.users.map((item, index) => {
    const old = oldUsers[item.sourceIndex] || {};
    const name = nonempty(item.name, `账号 ${index + 1} 名称`, 80);
    const session = nonempty(item.session || name, `账号 ${index + 1} Session`, 100);
    if (!/^[\w.-]+$/.test(session) || session === '.' || session === '..') throw new Error(`账号 ${name} 的 Session 名称无效`);
    if (seenSessions.has(session.toLowerCase())) throw new Error(`Session ${session} 被多个账号重复使用`);
    seenSessions.add(session.toLowerCase());
    const apiId = Number(item.apiId);
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error(`账号 ${name} 的 API ID 无效`);
    const apiHash = String(item.apiHash || '').trim() || old.api_hash;
    if (!apiHash) throw new Error(`账号 ${name} 缺少 API Hash`);
    const botItems = Array.isArray(item.bots) ? item.bots : (input.bots || []);
    if (!Array.isArray(botItems) || botItems.length > 500) throw new Error(`账号 ${name} 的 Bot 配置过多或格式不正确`);
    const seenBots = new Set();
    const button = [];
    const command = [];
    const botNotes = {};
    botItems.forEach((bot, botIndex) => {
      const botName = nonempty(bot.name, `账号 ${name} 的 Bot ${botIndex + 1} 用户名`, 100);
      if (!/^@[A-Za-z0-9_]{5,}$/.test(botName)) throw new Error(`Bot ${botName} 的用户名应以 @ 开头`);
      const key = botName.toLowerCase();
      if (seenBots.has(key)) throw new Error(`账号 ${name} 的 Bot ${botName} 重复`);
      seenBots.add(key);
      const note = String(bot.note || '').trim();
      if (note.length > 200) throw new Error(`${botName} 的备注不能超过 200 字`);
      if (note) botNotes[botName] = note;
      if (bot.mode === 'command') command.push({ bot: botName, command: nonempty(bot.command || '/sign', `${botName} 命令`, 100) });
      else if (bot.mode === 'button') button.push(botName);
      else throw new Error(`${botName} 的签到方式无效`);
    });
    return { ...old, name, session, api_id: apiId, api_hash: apiHash, dialog_folder: String(item.dialogFolder || '').trim(), bots: [], bot_groups: { button, command }, bot_notes: botNotes, checkin_schedules: validateCheckinSchedules(item.checkinSchedules || [], name, botItems.length) };
  });
  const providers = input.providers.map((item, index) => {
    const old = oldProviders[item.sourceIndex] || {};
    const name = nonempty(item.name, `AI 服务 ${index + 1} 名称`, 80);
    const baseUrl = nonempty(item.baseUrl, `AI 服务 ${name} 地址`, 500);
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`AI 服务 ${name} 地址须以 http:// 或 https:// 开头`);
    const apiKey = String(item.apiKey || '').trim() || old.api_key;
    if (!apiKey) throw new Error(`AI 服务 ${name} 缺少 API Key`);
    return { ...old, name, base_url: baseUrl, api_key: apiKey };
  });
  original.telegram = { ...(original.telegram || {}), users };
  delete original.telegram.dialog_folder;
  original.ai = { ...(original.ai || {}), model: providers.length ? nonempty(input.model, 'AI 模型', 120) : String(input.model || '').trim(), providers };
  delete original.ai.api_key;
  delete original.ai.base_url;
  delete original.users;
  delete original.bots;
  delete original.bot_groups;
  delete original.bot_notes;
  original.automations = validateAutomations(input.automations, users);
  const temp = `${CONFIG}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(original, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, CONFIG);
  return viewConfig(original);
}

let pythonCache = { expires: 0, value: null };
function pythonCommand() {
  if (Date.now() < pythonCache.expires) return pythonCache.value;
  const localPython = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const names = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : [localPython, ...(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'])];
  for (const name of names) {
    const args = name === 'py' ? ['-3', '--version'] : ['--version'];
    const result = spawnSync(name, args, { timeout: 3000, encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0) {
      pythonCache = { expires: Date.now() + 60000, value: { name, prefix: name === 'py' ? ['-3'] : [], version: (result.stdout || result.stderr).trim() } };
      return pythonCache.value;
    }
  }
  pythonCache = { expires: Date.now() + 5000, value: null };
  return null;
}

function addLine(text, stream = 'stdout') {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/tg:\/\/login\?token=[^\s]+/gi, 'tg://login?token=[已隐藏]');
  run.lines.push({ id: (run.lines.at(-1)?.id || 0) + 1, time: new Date().toISOString(), stream, text: clean.slice(0, 2000) });
  if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
}

function startRun(account = null, trigger = 'manual') {
  if (child) throw new Error('签到任务正在运行');
  const python = pythonCommand();
  if (!python) throw new Error('未找到 Python。安装 Python 及脚本依赖后，重新启动服务。');
  const config = viewConfig(readConfig());
  const selected = account ? config.users.filter(user => user.session === account) : config.users;
  if (!selected.length) throw new Error(`找不到账号 ${account}`);
  if (!selected.some(user => user.bots.length)) throw new Error('该账号没有配置签到 Bot，请先在账号管理中添加 Bot。');
  if (selected.some(user => user.bots.length && !user.sessionReady)) throw new Error('有配置了 Bot 的账号缺少 Session 文件。请先在账号管理中点击登录完成 Telegram 登录。');
  run = { state: 'running', trigger, account, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, lines: [] };
  addLine(`使用 ${python.version} 启动${account ? `账号 ${account} 的` : '批量'}签到`, 'system');
  child = spawn(python.name, [...python.prefix, '-u', 'allinone.py', ...(account ? ['--account', account] : [])], {
    cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    let buffer = '';
    pipe.setEncoding('utf8');
    pipe.on('data', chunk => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      parts.forEach(line => { if (line) addLine(line, stream); });
    });
    pipe.on('end', () => { if (buffer) addLine(buffer, stream); });
  }
  child.on('error', error => { addLine(error.message, 'stderr'); run.state = 'failed'; run.finishedAt = new Date().toISOString(); child = null; });
  child.on('close', code => {
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (run.state === 'running') run.state = code === 0 ? 'completed' : 'failed';
    addLine(`任务结束，退出码 ${code}`, 'system');
    child = null;
    if (scheduler.getState().queued) scheduler.tick().finally(() => { if (!child && !shuttingDown) automation.start(); });
    else automation.start();
  });
}

async function launchRun(account = null, trigger = 'manual') {
  if (child || runStarting || login.active()) throw new Error('签到或登录任务正在运行');
  runStarting = true;
  try {
    await automation.stop();
    try { startRun(account, trigger); }
    catch (error) { automation.start(); throw error; }
  } finally {
    runStarting = false;
    if (!child && !shuttingDown) automation.start();
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) { reject(new Error('请求内容过大')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON 格式不正确')); } });
    req.on('error', reject);
  });
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const login = createLoginController({ root: ROOT, dataDir: DATA_ROOT, readConfig, pythonCommand, isBusy: () => !!child || runStarting || shuttingDown, stopAutomation: () => automation.stop(), resumeAutomation: () => { if (!shuttingDown) automation.start(); } });
automation.configure({ root: ROOT, dataDir: DATA_ROOT, readConfig, pythonCommand, canRun: () => !child && !runStarting && !login.active() && !shuttingDown });
const scheduler = createScheduler({ root: DATA_ROOT, readConfig, runAccount: account => launchRun(account, 'scheduled'), isBusy: () => !!child || runStarting || login.active() || shuttingDown });
http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${PUBLIC_HOST}:${PORT}`) return send(res, 403, { error: '仅允许本地访问' });
    const url = new URL(req.url, `http://${PUBLIC_HOST}:${PORT}`);
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${PUBLIC_HOST}:${PORT}`) return send(res, 403, { error: '跨站请求被拒绝' });
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/login/status') return send(res, 200, { login: login.status() });
      if (req.method === 'POST' && url.pathname.startsWith('/api/login/')) {
        const input = await bodyJson(req);
        if (shuttingDown) throw new Error('服务正在停止');
        if (url.pathname === '/api/login/start') return send(res, 200, { login: await login.start(input.account) });
        if (url.pathname === '/api/login/password') return send(res, 200, { login: login.password(input.id, input.password) });
        if (url.pathname === '/api/login/cancel') return send(res, 200, { login: login.cancel(input.id) });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { config: viewConfig(readConfig()), run: { ...run, lines: run.lines.slice(-150) }, automation: automation.getState(), checkinScheduler: scheduler.getState(), python: pythonCommand()?.version || null });
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const input = await bodyJson(req);
        if (child || runStarting || login.active() || shuttingDown) throw new Error('运行或登录期间不能修改配置');
        const config = saveConfig(input);
        await automation.restart();
        return send(res, 200, { config, automation: automation.getState(), checkinScheduler: scheduler.getState() });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const input = await bodyJson(req);
        const account = input.account == null ? null : nonempty(input.account, '签到账号', 100);
        await launchRun(account);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/automation/restart') { if (child || runStarting || login.active() || shuttingDown) throw new Error('运行或登录期间不能重启自动化'); await automation.restart(); return send(res, 200, { automation: automation.getState() }); }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (!child) throw new Error('当前没有运行中的任务');
        run.state = 'stopping';
        addLine('正在停止任务…', 'system');
        child.kill();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: '接口不存在' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: '不支持的请求' });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'login.js', 'styles.css', 'controls.css', 'automation.css', 'account-dashboard.css'].includes(file)) return send(res, 404, { error: '页面不存在' });
    const target = path.join(PUBLIC, file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    send(res, 400, { error: error.message || '操作失败' });
  }
}).listen(PORT, HOST, () => {
  console.log(`AutoCheckin 管理页面：http://${PUBLIC_HOST}:${PORT}`);
  automation.start();
  scheduler.start();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  if (child) child.kill();
  scheduler.stop();
  await login.shutdown();
  await automation.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
