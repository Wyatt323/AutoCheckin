const { requestSecurity } = require('./admin_auth');
const { createUserAuth } = require('./user_auth');
const { createSystemSettings, applySystemConfig } = require('./system_settings');
const { createTelegramNotifications } = require('./telegram_notifications');
const CheckinResults = require('./checkin_results');
const { validateTime } = require('./schedule_time');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createAutomation } = require('./automation');
const { createScheduler } = require('./checkin_scheduler');
const { createLoginController } = require('./login');
const { resolveCredentials, credentialText } = require('./telegram_credentials');
const { createHash } = require('node:crypto');

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

function parseConfig(raw) {
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

async function createWorkspace({dataDir, store, prefix = '', systemSettings}) {
  const DATA_ROOT = dataDir, CONFIG = path.join(dataDir, 'config.json'), database = store;
  const workerEnv = {AUTOCHECKIN_DOCUMENT_PREFIX:prefix,AUTOCHECKIN_SYSTEM_DATA_DIR:path.resolve(process.env.AUTOCHECKIN_DATA_DIR || ROOT)};
  const automation = createAutomation();
  const notifications = await createTelegramNotifications({dataDir,store});
  let history, profiles, login, scheduler, chatResolver;
  let child = null, runStarting = false, nextRunAt = 0, run, shuttingDown = false;
  fs.mkdirSync(DATA_ROOT,{recursive:true,mode:0o700});
  if (prefix && !(database ? database.read('config') : fs.existsSync(CONFIG))) {
    const empty = {telegram:{users:[]},ai:{providers:[]},automations:{schedules:[],forwards:[]}};
    if (database) await database.write('config',empty);
    else fs.writeFileSync(CONFIG,JSON.stringify(empty),{mode:0o600});
  }
  function readConfig() {
    if (database) return structuredClone(database.read('config'));
    const raw = fs.readFileSync(CONFIG, 'utf8');
    return parseConfig(raw);
  }

  function discoveryKey(account) { return createHash('sha256').update(account).digest('hex'); }
  const effectiveConfig = () => applySystemConfig(readConfig(),systemSettings.read());
  function readDiscovery(account) {
    try { return database ? database.read(`discovery:${discoveryKey(account)}`) || {} : JSON.parse(fs.readFileSync(path.join(DATA_ROOT, '.bot-discovery', discoveryKey(account) + '.json'), 'utf8')); }
    catch { return {}; }
  }

  function viewConfig(config) {
    const telegram = config.telegram || {};
    const ai = config.ai || {};
    const parseBots = (scope, notes) => {
      const bots = [];
      const seen = new Set();
      const add = (name, mode, command = '/sign') => {
        name = String(name || '').trim();
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        bots.push({ name, mode, command, note: String(notes[name] || '') });
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
      telegram: { apiId: telegram.api_id || '', hasApiHash: Boolean(credentialText(telegram.api_hash)), useSystem:telegram.use_system === true },
      useSystemAI:ai.use_system === true,
      system:systemSettings.view(),
      users: (telegram.users || config.users || []).map((user, sourceIndex) => ({
        sourceIndex, name: user.name || '', session: user.session || user.name || '',
        apiId: user.api_id || '', hasApiHash: Boolean(credentialText(user.api_hash)),
        useGlobalCredentials: !credentialText(user.api_id) && !credentialText(user.api_hash),
        apiIdSource: credentialText(user.api_id) ? 'account' : 'global',
        apiHashSource: credentialText(user.api_hash) ? 'account' : 'global',
        sessionReady: fs.existsSync(path.join(DATA_ROOT, `${user.session || user.name}.session`)),
        profile: fs.existsSync(path.join(DATA_ROOT, `${user.session || user.name}.session`)) ? profiles.view(user.session || user.name) : null,
        dialogFolder: user.dialog_folder ?? telegram.dialog_folder ?? '',
        bots: parseBots(('bots' in user || 'bot_groups' in user) ? user : config, user.bot_notes || config.bot_notes || {}).map(bot => ({ ...bot, schedule:user.bot_schedules?.[bot.name] || { enabled:false, time:'09:00' } })),
        discoveredBots: Object.values(readDiscovery(user.session || user.name)).sort((a,b) => String(a.bot).localeCompare(String(b.bot))),
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
    if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(text)) return `@${text}`;
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
      const timing = validateTime(item, label);
      const message = nonempty(item.message, `${label} 内容`, 4000);
      return { id: idFor(item, label), enabled: item.enabled !== false, account: accountFor(item, label), target: chatRef(item.target, `${label} 目标`), ...timing, message };
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
      const timing = validateTime(item, label);
      if (item.enabled !== false && !botCount) throw new Error(`${label} 已启用，请先添加此账号的签到 Bot`);
      return { id, enabled: item.enabled !== false, ...timing };
    });
  }

  async function saveConfig(input) {
    if (!Array.isArray(input.users) || !Array.isArray(input.providers)) throw new Error('配置格式不正确');
    if (input.users.length > 30 || input.providers.length > 20) throw new Error('配置条目过多');
    const original = readConfig();
    const oldUsers = original.telegram?.users || original.users || [];
    const oldProviders = original.ai?.providers || [{ api_key: original.ai?.api_key }];
    const telegram = { ...(original.telegram || {}) };
    if (input.telegram !== undefined) {
      if (!input.telegram || typeof input.telegram !== 'object' || Array.isArray(input.telegram)) throw new Error('全局 Telegram 配置格式不正确');
      const rawId = credentialText(input.telegram.apiId);
      if (rawId && (!/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0)) throw new Error('全局 Telegram API ID 无效');
      telegram.api_id = rawId ? Number(rawId) : '';
      telegram.api_hash = credentialText(input.telegram.apiHash) || credentialText(telegram.api_hash);
      telegram.use_system = input.telegram.useSystem === true;
      if (telegram.use_system) resolveCredentials(applySystemConfig({telegram},systemSettings.read()),{});
    }
    const seenSessions = new Set();
    const users = input.users.map((item, index) => {
      const old = oldUsers[item.sourceIndex] || {};
      const name = nonempty(item.name, `账号 ${index + 1} 名称`, 80);
      const session = nonempty(item.session || name, `账号 ${index + 1} Session`, 100);
      if (!/^[\w.-]+$/.test(session) || session === '.' || session === '..') throw new Error(`账号 ${name} 的 Session 名称无效`);
      if (seenSessions.has(session.toLowerCase())) throw new Error(`Session ${session} 被多个账号重复使用`);
      seenSessions.add(session.toLowerCase());
      const rawId = item.useGlobalCredentials === true ? '' : credentialText(item.apiId);
      const apiId = rawId ? Number(rawId) : '';
      const apiHash = item.useGlobalCredentials === true || item.clearApiHash === true ? '' : credentialText(item.apiHash) || credentialText(old.api_hash);
      if (rawId && (!/^\d+$/.test(rawId) || !Number.isSafeInteger(apiId) || apiId <= 0)) throw new Error(`账号 ${name} 的 API ID 无效`);
      try { resolveCredentials(applySystemConfig({ telegram },systemSettings.read()), { api_id: apiId, api_hash: apiHash }); }
      catch (error) { throw new Error(`账号 ${name}：${error.message}`); }
      const botItems = Array.isArray(item.bots) ? item.bots : (input.bots || []);
      if (!Array.isArray(botItems) || botItems.length > 500) throw new Error(`账号 ${name} 的 Bot 配置过多或格式不正确`);
      const seenBots = new Set();
      const button = [];
      const command = [];
      const botNotes = {};
      const botSchedules = {};
      botItems.forEach((bot, botIndex) => {
        const botName = nonempty(bot.name, `账号 ${name} 的 Bot ${botIndex + 1} 用户名`, 100);
        if (!/^@[A-Za-z0-9_]{5,}$/.test(botName)) throw new Error(`Bot ${botName} 的用户名应以 @ 开头`);
        const key = botName.toLowerCase();
        if (seenBots.has(key)) throw new Error(`账号 ${name} 的 Bot ${botName} 重复`);
        seenBots.add(key);
        const note = String(bot.note || '').trim();
        if (note.length > 200) throw new Error(`${botName} 的备注不能超过 200 字`);
        if (note) botNotes[botName] = note;
        if (bot.schedule?.enabled === true) {
          const timing = validateTime({repeat:'daily', timeMode:'fixed', time:bot.schedule.time}, `${botName} 独立定时`);
          botSchedules[botName] = { enabled:true, time:timing.time };
        }
        if (bot.mode === 'command') command.push({ bot: botName, command: nonempty(bot.command || '/sign', `${botName} 命令`, 100) });
        else if (bot.mode === 'button') button.push(botName);
        else throw new Error(`${botName} 的签到方式无效`);
      });
      const folder = item.botSource === 'configured' ? '' : String(item.dialogFolder || '').trim();
      if (item.botSource === 'folder' && !folder) throw new Error('请填写 Telegram 对话分组名称或 ID');
      if (folder.length > 100) throw new Error('Telegram 分组名称过长');
      return { ...old, name, session, api_id: apiId, api_hash: apiHash, dialog_folder: folder, bots: [], bot_groups: { button, command }, bot_notes: botNotes, bot_schedules:botSchedules, checkin_schedules: validateCheckinSchedules(item.checkinSchedules || [], name, folder ? 1 : botItems.length) };
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
    original.telegram = { ...telegram, users };
    delete original.telegram.dialog_folder;
    if (input.useSystemAI === true && !systemSettings.read().ai?.providers?.length) throw Error('管理员尚未配置系统 AI 提供商');
    original.ai = { ...(original.ai || {}), use_system:input.useSystemAI === true, model: providers.length ? nonempty(input.model, 'AI 模型', 120) : String(input.model || '').trim(), providers };
    delete original.ai.api_key;
    delete original.ai.base_url;
    delete original.users;
    delete original.bots;
    delete original.bot_groups;
    delete original.bot_notes;
    original.automations = validateAutomations(input.automations, users);
    const temp = `${CONFIG}.tmp`;
    if (database) await database.write('config', original);
    else {
      fs.writeFileSync(temp, JSON.stringify(original, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, CONFIG);
    }
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

  function addLine(text, stream = 'stdout', account = run.account, detail = {}) {
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/tg:\/\/login\?token=[^\s]+/gi, 'tg://login?token=[已隐藏]');
    run.lines.push({ id: (run.lines.at(-1)?.id || 0) + 1, time: new Date().toISOString(), stream, text: clean.slice(0, 2000), runId: run.id, account, trigger: run.trigger, ...detail });
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
    history.changed();
  }

  async function startRun(account = null, trigger = 'manual', bot = null) {
    if (child) throw new Error('签到任务正在运行');
    const python = pythonCommand();
    if (!python) throw new Error('未找到 Python。安装 Python 及脚本依赖后，重新启动服务。');
    const config = viewConfig(readConfig());
    const selected = account ? config.users.filter(user => user.session === account) : config.users;
    if (!selected.length) throw new Error(`找不到账号 ${account}`);
    if (!selected.some(user => user.bots.length || user.dialogFolder)) throw new Error('请先在 Bot 管理中添加 Bot 或设置 Telegram 对话分组。');
    if (selected.some(user => (user.bots.length || user.dialogFolder) && !user.sessionReady)) throw new Error('有配置签到的账号缺少 Session 文件，请先登录 Telegram。');
    if (bot && (!account || !selected[0].bots.some(item => item.name.toLowerCase() === bot.toLowerCase()))) throw new Error('独立签到 Bot 不在此账号配置中');
    if (bot && selected[0].dialogFolder) throw new Error('当前使用分组轮询，配置列表的独立定时暂不生效');
    run = history.create(account, trigger);
    run.bot = bot;
    run.botNote = selected[0]?.bots.find(item=>item.name.toLowerCase()===String(bot).toLowerCase())?.note || '';
    try { await history.flush(); }
    catch { run.state='failed'; run.finishedAt=new Date().toISOString(); throw new Error('执行记录无法保存，本次任务未启动'); }
    addLine(`使用 ${python.version} 启动${account ? `账号 ${account} 的` : '批量'}${trigger === 'scheduled' ? bot ? ` Bot ${bot} 独立定时` : '定时' : '手动'}签到`, 'system');
    child = spawn(python.name, [...python.prefix, '-u', 'allinone.py', ...(account ? ['--account', account] : []), ...(bot ? ['--bot', bot] : []), ...(trigger === 'scheduled' ? ['--scheduled'] : [])], {
      cwd: ROOT, env: { ...process.env, ...workerEnv, AUTOCHECKIN_DATA_DIR:DATA_ROOT, AUTOCHECKIN_LOG_JSON:'1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const accounts = new Set(selected.map(user => user.session));
    function output(line, stream) {
      try {
        const event = JSON.parse(line);
        if(event.type==='bot_result') {
          if(!accounts.has(event.account) || typeof event.bot!=='string' || !['success','already','timeout','failed','skipped','unknown'].includes(event.status))return;
          const entry={account:event.account,bot:event.bot.slice(0,100),name:String(event.name || event.bot).slice(0,200),note:String(event.note || '').slice(0,200),status:event.status,result:String(event.result || '').slice(0,200)};
          run.botResults ||= [];
          const index=run.botResults.findIndex(item=>item.account===entry.account && CheckinResults.key(item.bot)===CheckinResults.key(entry.bot));
          if(index>=0)run.botResults[index]=entry;else if(run.botResults.length<2000)run.botResults.push(entry);
          addLine(CheckinResults.resultLine(entry),entry.status==='failed' || entry.status==='timeout' ? 'stderr' : 'stdout',entry.account,{botResult:entry});
          return;
        }
        if (['checkin_log','account_result'].includes(event.type)) {
          const owner = accounts.has(event.account) ? event.account : run.account;
          if (event.type === 'account_result') {
            if (owner && ['completed','failed'].includes(event.state)) (run.accountStates ||= Object.create(null))[owner] = event.state;
            history.changed();
            return;
          }
          if (typeof event.text === 'string') {
            if (owner) (run.accountStates ||= Object.create(null))[owner] ||= 'running';
            addLine(event.text, event.stream === 'stderr' ? 'stderr' : 'stdout', owner);
            return;
          }
        }
      } catch {}
      addLine(line, stream);
    }
    for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      let buffer = '';
      pipe.setEncoding('utf8');
      pipe.on('data', chunk => {
        buffer += chunk;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        parts.forEach(line => { if (line) output(line, stream); });
        if (buffer.length > 65536) { output(buffer, stream); buffer = ''; }
      });
      pipe.on('end', () => { if (buffer) output(buffer, stream); });
    }
    child.on('error', error => { addLine(error.message, 'stderr'); run.state = 'failed'; run.finishedAt = new Date().toISOString(); history.changed(true); });
    child.on('close', async code => {
      run.exitCode = code;
      run.finishedAt = new Date().toISOString();
      if (run.state === 'stopping') run.state = 'stopped';
      else if (run.state === 'running') run.state = code === 0 ? 'completed' : 'failed';
      for (const owner of Object.keys(run.accountStates || {})) if (run.accountStates[owner] === 'running') run.accountStates[owner] = run.state;
      addLine(`任务结束，退出码 ${code}`, 'system');
      history.changed(true);
      const finishedRun=structuredClone(run);
      try {await notifications.notifyRun(finishedRun,selected.find(user=>user.session===finishedRun.account)?.name);}
      catch {console.error('定时签到通知入队失败');}
      child = null;
      nextRunAt = Date.now() + (5 + Math.floor(Math.random() * 11)) * 1000;
      if (database) for (const user of config.users) await database.refresh(`discovery:${discoveryKey(user.session)}`).catch(() => {});
      if (!shuttingDown) {
        if (scheduler.getState().queued) scheduler.tick().finally(() => { if (!child && !shuttingDown) automation.start(); });
        else automation.start();
      }
    });
  }

  async function launchRun(account = null, trigger = 'manual', bot = null) {
    if (child || runStarting || login.active()) throw new Error('签到或登录任务正在运行');
    runStarting = true;
    try {
      const delay = Math.max(0, nextRunAt - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (shuttingDown) throw new Error('服务正在停止');
      await automation.stop();
      try {
        if (shuttingDown) throw new Error('当前用户工作空间已关闭');
        await startRun(account, trigger, bot);
      }
      catch (error) { automation.start(); throw error; }
    } finally {
      runStarting = false;
      if (!child && !shuttingDown) automation.start();
    }
  }

  history = require('./run_history').createRunHistory(DATA_ROOT, database);
  profiles = require('./account_profiles').createProfileStore(DATA_ROOT, database);
  run = history.latest() || { state:'idle', lines:[] };
  nextRunAt = run.finishedAt ? Date.parse(run.finishedAt) + 5000 : 0;
  login = createLoginController({ workerEnv, root: ROOT, dataDir: DATA_ROOT, readConfig:effectiveConfig, pythonCommand, isBusy: () => !!child || runStarting || shuttingDown, stopAutomation: () => automation.stop(), resumeAutomation: () => { if (!shuttingDown) automation.start(); }, onComplete:async account => { if (database) await database.refresh(`profile:${discoveryKey(account)}`); } });
  automation.configure({ workerEnv, root: ROOT, dataDir: DATA_ROOT, store:database, readConfig, pythonCommand, onEvent:event => history.appendEvent(event), canRun: () => !child && !runStarting && !login.active() && !shuttingDown });
  scheduler = createScheduler({ root: DATA_ROOT, store:database, readConfig, runAccount: async (account, bot, occurrence) => {
    try {await launchRun(account, 'scheduled', bot);}
    catch(error) {
      if(!shuttingDown) {
        const time=new Date().toISOString(), name=viewConfig(readConfig()).users.find(user=>user.session===account)?.name;
        await notifications.notifyRun({id:'startup:'+occurrence.key,account,bot,trigger:'scheduled',state:'startup_failed',startedAt:time,finishedAt:time},name).catch(()=>console.error('定时启动失败通知入队失败'));
      }
      throw error;
    }
  }, isBusy: () => !!child || runStarting || login.active() || shuttingDown || Date.now() < nextRunAt });
  for(const record of history.snapshot({category:'checkin'}).records)if(record.trigger==='scheduled' && record.lines.some(line=>line.text==='服务重启，本次任务已中断'))await notifications.notifyRun(record).catch(()=>console.error('中断任务通知入队失败'));
  return {
    start() { notifications.start(); automation.start(); scheduler.start(); },
    audit(account = '') {
      const raw = readConfig(), config = viewConfig(raw);
      const secrets = [...new Set([raw.telegram?.api_hash,...(raw.telegram?.users || raw.users || []).map(item=>item.api_hash),raw.ai?.api_key,...(raw.ai?.providers || []).map(item=>item.api_key),systemSettings.read().telegram?.api_hash,...(systemSettings.read().ai?.providers || []).map(item=>item.api_key)].filter(value=>typeof value === 'string' && value))].sort((a,b)=>b.length-a.length);
      const redact = text => notifications.redact(secrets.reduce((value,secret)=>value.split(secret).join('[已隐藏]'),String(text || '')).replace(/tg:\/\/login\?token=[^\s]+/gi,'tg://login?token=[已隐藏]'));
      const redactResult = item => ({...item,bot:redact(item.bot),name:redact(item.name),note:redact(item.note),result:redact(item.result)});
      const records = history.snapshot({category:'checkin'}).records;
      const logs = history.snapshot({account,category:'checkin'});
      return {
        logAccounts:[...new Set(records.flatMap(record=>[record.account,...record.lines.map(line=>line.account)]).filter(Boolean))],
        accounts:config.users.map(user=>({
          name:user.name, session:user.session, dialogFolder:user.dialogFolder,
          bots:user.bots.map(bot=>({name:bot.name,mode:bot.mode,command:bot.command,note:bot.note,schedule:bot.schedule})),
          discoveredBots:user.discoveredBots.map(bot=>({bot:bot.bot,mode:bot.mode,command:bot.command,lastResult:bot.lastResult}))
        })),
        revision:logs.revision,
        records:logs.records.map(record=>({...record,botNote:redact(record.botNote),...(record.botResults ? {botResults:record.botResults.map(redactResult)} : {}),lines:record.lines.map(line=>({...line,text:redact(line.text),...(line.botResult ? {botResult:redactResult(line.botResult)} : {})}))}))
      };
    },
    async refreshSettings() {
      if (!readConfig().telegram?.use_system || shuttingDown) return true;
      if (child || runStarting || login.active()) return false;
      await automation.restart(); return true;
    },
    async handle(req,res,url,authUser) {
        if (shuttingDown) return send(res,403,{error:'当前用户工作空间已关闭'});
        if(url.pathname==='/api/notifications') {
          if(req.method==='GET')return send(res,200,{notifications:notifications.view()});
          if(req.method==='PUT')return send(res,200,{notifications:await notifications.update(await bodyJson(req))});
          return send(res,405,{error:'不支持的请求'});
        }
        if(url.pathname==='/api/notifications/test' && req.method==='POST') {
          await notifications.test();return send(res,202,{ok:true,notifications:notifications.view()});
        }
        if (req.method === 'POST' && url.pathname === '/api/accounts/bots/discovery/reset') {
          if (child || runStarting || login.active() || shuttingDown) throw new Error('请在任务结束后重新识别');
          const input = await bodyJson(req);
          const user = viewConfig(readConfig()).users.find(user => user.session === input.account);
          if (!user) throw new Error('账号不存在');
          const records = structuredClone(readDiscovery(user.session));
          const bot = nonempty(input.bot, 'Bot', 100).toLowerCase();
          delete records[bot];
          if (database) await database.write(`discovery:${discoveryKey(user.session)}`, records);
          else {
            const directory = path.join(DATA_ROOT, '.bot-discovery'); fs.mkdirSync(directory, {recursive:true});
            const file = path.join(directory, discoveryKey(user.session) + '.json');
            fs.writeFileSync(file + '.tmp', JSON.stringify(records), {mode:0o600}); fs.renameSync(file + '.tmp', file);
          }
          return send(res, 200, {ok:true, records:Object.values(records)});
        }
        if (req.method === 'GET' && url.pathname === '/api/accounts/avatar') {
          const account = url.searchParams.get('account');
          const user = viewConfig(readConfig()).users.find(user => user.session === account && user.sessionReady);
          const avatar = user && profiles.read(account)?.avatar;
          if (!avatar) return send(res, 404, { error: '暂无头像' });
          res.writeHead(200, { 'Content-Type':'image/jpeg', 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' });
          return res.end(avatar);
        }
        if (req.method === 'POST' && url.pathname === '/api/accounts/chats/resolve') {
          if (shuttingDown) throw new Error('服务正在停止');
          const input = await bodyJson(req);
          chatResolver ||= require('./chat_resolver').createChatResolver({workerEnv,root:ROOT, dataDir:DATA_ROOT, readConfig:effectiveConfig, pythonCommand});
          return send(res, 200, {results:await chatResolver.resolve(input.account, input.peers)});
        }
        if (req.method === 'POST' && url.pathname === '/api/accounts/profile/refresh') {
          if (shuttingDown) throw new Error('服务正在停止');
          return send(res, 200, { login: await login.start((await bodyJson(req)).account, { profileOnly:true }) });
        }
        if (req.method === 'GET' && url.pathname === '/api/login/status') return send(res, 200, { login: login.status() });
        if (req.method === 'POST' && url.pathname.startsWith('/api/login/')) {
          const input = await bodyJson(req);
          if (shuttingDown) throw new Error('服务正在停止');
          if (url.pathname === '/api/login/start') return send(res, 200, { login: await login.start(input.account) });
          if (url.pathname === '/api/login/password') return send(res, 200, { login: login.password(input.id, input.password) });
          if (url.pathname === '/api/login/cancel') return send(res, 200, { login: login.cancel(input.id) });
        }
        if (req.method === 'GET' && url.pathname === '/api/runs') return send(res, 200, history.snapshot({account:url.searchParams.get('account') || '', category:url.searchParams.get('category') || ''}));
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const state = { user: authUser, run: { ...run, lines: run.lines.slice(-150) }, automation: automation.getState(), checkinScheduler: scheduler.getState(), python: pythonCommand()?.version || null };
          // Routine polling needs status only; initial load and explicit refresh keep the full response.
          if (url.searchParams.get('config') !== '0') state.config = viewConfig(readConfig());
          return send(res, 200, state);
        }
        if (req.method === 'POST' && url.pathname === '/api/config') {
          const input = await bodyJson(req);
          if (child || runStarting || login.active() || shuttingDown) throw new Error('运行或登录期间不能修改配置');
          const config = await saveConfig(input);
          await automation.restart();
          return send(res, 200, { config, automation: automation.getState(), checkinScheduler: scheduler.getState() });
        }
        if (req.method === 'POST' && url.pathname === '/api/run') {
          const input = await bodyJson(req);
          const account = input.account == null ? null : nonempty(input.account, '签到账号', 100);
          await launchRun(account, 'manual', input.bot ? nonempty(input.bot, '签到 Bot', 100) : null);
          return send(res, 200, { ok: true, run: { ...run } });
        }
        if (req.method === 'POST' && url.pathname === '/api/automation/restart') { if (child || runStarting || login.active() || shuttingDown) throw new Error('运行或登录期间不能重启自动化'); await automation.restart(); return send(res, 200, { automation: automation.getState() }); }
        if (req.method === 'POST' && url.pathname === '/api/stop') {
          const input = await bodyJson(req);
          if (input.id && input.id !== run.id) throw new Error('此任务已结束，不能停止其他任务');
          if (!child) throw new Error('当前没有运行中的任务');
          run.state = 'stopping';
          addLine('正在停止任务…', 'system');
          child.kill();
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: '接口不存在' });
    },
    async stop() {
      shuttingDown = true;
      scheduler.stop();
      if (child) {
        const worker = child;
        await new Promise(resolve => {
          const timeout = setTimeout(()=>{worker.kill('SIGKILL');},3000);
          worker.once('close',()=>{clearTimeout(timeout);resolve();});
          worker.kill();
        });
      }
      await login.shutdown();
      await chatResolver?.shutdown();
      await automation.stop();
      await notifications.stop();
      await history.flush();
    }
  };
}

let database = null, shuttingDown = false;
async function boot() {
  database = await require('./database').createDatabase({dataDir:DATA_ROOT,parseConfig});
  const auth = await createUserAuth({dataDir:DATA_ROOT,store:database});
  const systemSettings = await createSystemSettings({dataDir:DATA_ROOT,store:database});
  const workspaces = new Map();
  async function workspaceFor(user) {
    const id = user.id;
    if (!workspaces.has(id)) {
      const prefix = id === 'admin' ? '' : `tenant:${id}:`;
      const dataDir = id === 'admin' ? DATA_ROOT : path.join(DATA_ROOT,'.user-workspaces',id);
      const pending = createWorkspace({dataDir,store:require('./database').scopedStore(database,prefix),prefix,systemSettings}).then(workspace=>{workspace.start();return workspace;});
      workspaces.set(id,pending);
      pending.catch(()=>{workspaces.delete(id);});
    }
    return workspaces.get(id);
  }
  await workspaceFor({id:'admin'});
  for (const user of auth.list()) await workspaceFor(user);
  const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
http.createServer(async (req, res) => {
  try {
    const security = requestSecurity(req, { publicHost: PUBLIC_HOST, port: Number(process.env.PUBLIC_PORT || PORT), trustProxy: process.env.TRUST_PROXY === 'true' });
    if (security.error) return send(res, 403, { error: security.error });
    const url = new URL(req.url, `http://${PUBLIC_HOST}:${PORT}`);
    const user = auth.identity(req);
    if (req.method === 'GET' && url.pathname === '/api/auth/status') return send(res,200,{authenticated:Boolean(user),configured:auth.configured,adminUsername:auth.adminUsername(),user});
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const result = await auth.login(req,await bodyJson(req),security.secure);
      if (result.cookie) res.setHeader('Set-Cookie',result.cookie);
      return send(res,result.status,result.error ? {error:result.error} : {ok:true,user:result.user});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      res.setHeader('Set-Cookie',auth.logout(req,security.secure)); return send(res,200,{ok:true});
    }
    const publicFiles = new Set(['/login','/auth.css','/auth.js','/styles.css','/theme.css','/favicon.svg']);
    if (!user && !publicFiles.has(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res,401,{error:'请先登录管理后台'});
      res.writeHead(302,{Location:'/login','Cache-Control':'no-store'}); return res.end();
    }
    if (user && req.method === 'POST' && url.pathname === '/api/auth/password') return send(res,200,{ok:true,user:await auth.changePassword(req,await bodyJson(req))});
    if (user?.mustChangePassword && !publicFiles.has(url.pathname) && url.pathname !== '/password') {
      if (url.pathname.startsWith('/api/')) return send(res,403,{error:'首次登录必须先修改密码',mustChangePassword:true});
      res.writeHead(302,{Location:'/password','Cache-Control':'no-store'}); return res.end();
    }
    if (url.pathname === '/login' && user) {
      res.writeHead(302,{Location:user.mustChangePassword ? '/password' : '/','Cache-Control':'no-store'}); return res.end();
    }
    if (url.pathname === '/password' && !user) { res.writeHead(302,{Location:'/login'}); return res.end(); }
    if (url.pathname === '/api/admin/audit/users' || url.pathname.startsWith('/api/admin/audit/users/')) {
      if (user.role !== 'admin') return send(res,403,{error:'仅管理员可查看后台审计'});
      if (req.method !== 'GET') return send(res,405,{error:'审计功能仅支持查看'});
      if (url.pathname === '/api/admin/audit/users') return send(res,200,{users:auth.list()});
      const match = url.pathname.match(/^\/api\/admin\/audit\/users\/([a-f0-9-]{36})$/);
      const target = match && auth.list().find(item=>item.id === match[1]);
      if (!target) return send(res,404,{error:'用户不存在或已删除'});
      const account = url.searchParams.get('account') || '';
      if (account.length > 100) return send(res,400,{error:'账号筛选值过长'});
      const workspace = await workspaceFor(target);
      if (auth.identity(req)?.role !== 'admin') return send(res,401,{error:'请重新登录管理员账号'});
      if (!auth.list().some(item=>item.id === target.id)) return send(res,404,{error:'用户不存在或已删除'});
      return send(res,200,{user:target,...workspace.audit(account)});
    }
    if (url.pathname === '/api/admin/profile' || url.pathname === '/api/admin/settings') {
      if (user.role !== 'admin') return send(res,403,{error:'仅管理员可修改系统设置'});
      if (url.pathname === '/api/admin/profile' && req.method === 'PATCH') return send(res,200,{user:await auth.updateAdministrator((await bodyJson(req)).username)});
      if (url.pathname === '/api/admin/settings' && req.method === 'GET') return send(res,200,{settings:systemSettings.view()});
      if (url.pathname === '/api/admin/settings' && req.method === 'PUT') {
        const settings = await systemSettings.update(await bodyJson(req));
        let deferred = 0;
        for (const pending of workspaces.values()) if (!await (await pending).refreshSettings()) deferred++;
        return send(res,200,{settings,deferred});
      }
      return send(res,405,{error:'不支持的请求'});
    }
    if (url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
      if (user.role !== 'admin') return send(res,403,{error:'仅管理员可管理网页用户'});
      if (url.pathname !== '/api/users') {
        const match = url.pathname.match(/^\/api\/users\/([a-f0-9-]{36})(?:\/(reset-password))?$/);
        if (!match) return send(res,404,{error:'用户不存在'});
        const id = match[1];
        if (req.method === 'PATCH' && !match[2]) return send(res,200,{user:await auth.update(id,(await bodyJson(req)).username)});
        if (req.method === 'POST' && match[2]) return send(res,200,{user:await auth.resetPassword(id)});
        if (req.method === 'DELETE' && !match[2]) {
          await auth.remove(id);
          const pending = workspaces.get(id);
          if (pending) { await (await pending).stop(); workspaces.delete(id); }
          return send(res,200,{ok:true});
        }
        return send(res,405,{error:'不支持的请求'});
      }
      if (req.method === 'GET') return send(res,200,{users:auth.list()});
      if (req.method === 'POST') {
        const created = await auth.add((await bodyJson(req)).username);
        await workspaceFor(created);
        return send(res,201,{user:created});
      }
      return send(res,405,{error:'不支持的请求'});
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/state') res.setHeader('X-Workspace-User',user.username);
      const workspace = await workspaceFor(user);
      if (auth.identity(req)?.id !== user.id) return send(res,401,{error:'登录状态已失效，请重新登录'});
      return await workspace.handle(req,res,url,user);
    }
    if (req.method !== 'GET') return send(res, 405, { error: '不支持的请求' });
    const file = url.pathname === '/' ? 'index.html' : ['/login','/password'].includes(url.pathname) ? 'auth.html' : url.pathname.slice(1);
    if (!['auth.html', 'auth.css', 'auth.js', 'index.html', 'app.js', 'login.js', 'styles.css', 'controls.css', 'automation.css', 'account-dashboard.css', 'run-log.js', 'checkin-results.js', 'run-log.css', 'ui-controls.js', 'users.js', 'audit.js', 'notifications.js', 'ui-controls.css', 'theme.css', 'favicon.svg'].includes(file)) return send(res, 404, { error: '页面不存在' });
    const target = file==='checkin-results.js' ? path.join(ROOT,'checkin_results.js') : path.join(PUBLIC, file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    send(res, 400, { error: error.message || '操作失败' });
  }
 }).listen(PORT,HOST,()=>console.log(`AutoCheckin 管理页面：http://${PUBLIC_HOST}:${PORT}`));
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(()=>process.exit(1),10000); deadline.unref();
    await Promise.all([...workspaces.values()].map(async pending=>(await pending).stop()));
    if (database) await database.close();
    process.exit(0);
  }
  process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
}
boot().catch(error=>{console.error(`服务初始化失败（${error.code || error.name}），请检查数据库连接及迁移文件。`);process.exitCode=1;});
