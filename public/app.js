let config = null;
let currentRun = null;
let pythonVersion = null;
let currentView = 'overview';
let lastLogId = 0;
let openModeIndex = null;
let automationState = null;
let checkinSchedulerState = null;
let openAutoSelect = null;
let selectedAccountIndex = null;
let accountSection = 'settings';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const formatDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const statusText = { idle:'待运行', running:'运行中', stopping:'正在停止', completed:'已完成', failed:'运行失败' };

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function navigate(view, keepAccount = false) {
  if (view === 'bots') view = 'accounts';
  if (view === 'automation') {
    openAccount(selectedAccountIndex ?? 0, 'messages');
    return;
  }
  if (view === 'accounts' && !keepAccount) selectedAccountIndex = null;
  closeModeMenu();
  closeAutoSelect();
  if (config) { readEditors(); if (view === 'accounts') renderConfig(); }
  currentView = view;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach(item => item.classList.toggle('active', item.id === `view-${view}`));
  $('#breadcrumb').textContent = ({ overview:'总览', accounts:selectedAccountIndex === null ? '账号管理' : config.users[selectedAccountIndex]?.name || '账号配置', ai:'AI 配置', activity:'运行日志' })[view];
  window.location.hash = view;
  if (view === 'activity') renderRun();
}

function openAccount(index, section = 'settings') {
  if (!config?.users[index]) return;
  readEditors();
  selectedAccountIndex = index;
  accountSection = section;
  navigate('accounts', true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAccountSection(section) {
  accountSection = section;
  $$('#account-tabs [data-account-section]').forEach(button => button.classList.toggle('active', button.dataset.accountSection === section));
  $$('#account-editor .account-pane,[data-account-pane="messages"],[data-account-pane="forwards"]').forEach(pane => { pane.hidden = pane.dataset.accountPane !== section; });
}

function renderAccountBots(user, accountIndex) {
  const rows = user.bots.length ? user.bots.map((bot, botIndex) => `
    <tr data-bot-index="${botIndex}"><td><input class="cell-input" data-field="name" value="${escapeHtml(bot.name)}" placeholder="@example_bot" aria-label="Bot 用户名"></td>
    <td><button type="button" class="mode-trigger" data-mode-trigger="${accountIndex}:${botIndex}" role="combobox" aria-label="签到方式" aria-haspopup="listbox" aria-controls="mode-menu" aria-expanded="false"><span class="mode-icon">${bot.mode === 'command' ? '⌘' : '↖'}</span><span class="mode-label">${bot.mode === 'command' ? '发送命令' : '点击按钮'}</span><span class="mode-chevron" aria-hidden="true"></span></button></td>
    <td><input class="cell-input" data-field="command" value="${escapeHtml(bot.command || '/sign')}" ${bot.mode === 'button' ? 'disabled' : ''} aria-label="签到命令"></td>
    <td><input class="cell-input bot-note" data-field="note" value="${escapeHtml(bot.note || '')}" placeholder="用途或站点名称" maxlength="200" aria-label="Bot 备注"></td>
    <td><button class="delete-btn" data-delete="bot" data-account-index="${accountIndex}" data-index="${botIndex}">删除</button></td></tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:#aab4c5;padding:30px">此账号还没有 Bot，点击右上角添加。</td></tr>';
  return `<div class="account-bots-head"><div><strong>签到 Bot <span class="count-pill">${user.bots.length}</span></strong><small>仅当前账号会运行这些 Bot</small></div><button class="outline-btn" data-add-bot="${accountIndex}">＋ 添加 Bot</button></div><div class="table-wrap"><table class="bot-table"><thead><tr><th>Bot 用户名</th><th>签到方式</th><th>命令</th><th>备注</th><th></th></tr></thead><tbody class="account-bot-table">${rows}</tbody></table></div>`;
}

function scheduleTimeFields(item, kind) {
  const random = item.repeat === 'daily' && item.timeMode === 'random';
  return `${item.repeat === 'daily' ? `<label class="auto-field"><span>时间模式</span><select data-field="timeMode" data-time-mode="${kind}"><option value="fixed" ${!random ? 'selected' : ''}>固定时间</option><option value="random" ${random ? 'selected' : ''}>每日区间随机</option></select></label>` : ''}${random ? `<label class="auto-field"><span>区间开始 · 北京时间</span><input data-field="rangeStart" type="time" step="1" value="${escapeHtml(item.rangeStart || '09:00:00')}"></label><label class="auto-field"><span>区间结束 · 北京时间</span><input data-field="rangeEnd" type="time" step="1" value="${escapeHtml(item.rangeEnd || '10:30:00')}"></label>` : `<label class="auto-field"><span>${item.repeat === 'once' ? '执行时间' : '每日时间'} · 北京时间</span><input data-field="time" type="${item.repeat === 'once' ? 'datetime-local' : 'time'}" step="1" value="${escapeHtml(item.time || '')}"></label>`}<small data-planned-kind="${kind}" data-planned-id="${escapeHtml(item.id)}" data-planned-account="${escapeHtml(item.account || config.users[selectedAccountIndex]?.session || '')}"></small>`;
}
function renderPlannedTimes() {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  $$('[data-planned-id]').forEach(element => {
    const plans = element.dataset.plannedKind === 'checkin' ? checkinSchedulerState?.planned : automationState?.planned;
    const plan = plans?.find(plan => plan.account === element.dataset.plannedAccount && plan.ruleId === element.dataset.plannedId && plan.date === today);
    const row = element.closest('.checkin-rule,.automation-card');
    const mode = row?.querySelector('[data-field="timeMode"]')?.value;
    element.textContent = mode === 'random' ? (plan ? `今日抽中：${plan.time}（北京时间）` : '今日抽中：等待保存并启动计划') : '';
  });
}
function renderCheckinSchedules(user, accountIndex) {
  const schedules = user.checkinSchedules || [];
  const rows = schedules.length ? schedules.map((item, index) => `
    <div class="checkin-rule" data-checkin-index="${index}">
      <div class="checkin-rule-head"><strong>任务 ${index + 1}</strong><div class="automation-card-actions"><label class="auto-switch"><input type="checkbox" data-field="enabled" ${item.enabled !== false ? 'checked' : ''}><i></i>启用</label><button class="delete-btn" data-delete="checkin" data-account-index="${accountIndex}" data-index="${index}">删除</button></div></div>
      <div class="checkin-rule-fields"><div class="auto-field"><span>执行频率</span><div class="checkin-segments" role="group" aria-label="执行频率"><button type="button" data-checkin-repeat="daily" data-account-index="${accountIndex}" data-index="${index}" aria-pressed="${item.repeat === 'daily'}">每天</button><button type="button" data-checkin-repeat="once" data-account-index="${accountIndex}" data-index="${index}" aria-pressed="${item.repeat === 'once'}">仅一次</button></div></div>${scheduleTimeFields(item, 'checkin')}</div>
    </div>`).join('') : '<div class="automation-empty">还没有定时签到任务。添加后会自动运行此账号的全部签到 Bot。</div>';
  return `<div class="account-bots-head checkin-head"><div><strong>定时任务 <span class="count-pill">${schedules.length}</span></strong><small>按北京时间执行此账号的签到 Bot；一次性任务过期 5 分钟后不补跑。</small><small class="checkin-status" data-checkin-status="${accountIndex}"></small></div><button class="outline-btn" data-add-checkin="${accountIndex}">＋ 添加任务</button></div><div class="checkin-rules">${rows}</div>`;
}

function renderConfig() {
  closeModeMenu();
  closeAutoSelect();
  $('#stat-users').textContent = config.users.length;
  $('#stat-bots').textContent = config.users.reduce((sum, user) => sum + user.bots.length, 0);
  $('#stat-providers').textContent = config.providers.length;
  $('#model-input').value = config.model;
  config.telegram ||= { apiId: '', hasApiHash: false };
  $('#global-api-id').value = config.telegram.apiId || '';
  $('#global-api-hash').value = config.telegram.apiHash || '';
  $('#global-api-hash').placeholder = config.telegram.hasApiHash ? '已保存 · 留空保持不变' : '填写全局 API Hash';
  $('#global-api-status').textContent = config.telegram.apiId && (config.telegram.hasApiHash || config.telegram.apiHash) ? '全局凭据已配置' : '全局凭据未完整配置（独立账号仍可使用）';
  $('#account-list').innerHTML = config.users.map((user, index) => {
    const messageCount = config.automations.schedules.filter(item => item.account === user.session).length;
    const forwardCount = config.automations.forwards.filter(item => item.account === user.session).length;
    const latest = checkinSchedulerState?.events?.filter(item => item.account === user.session).at(-1);
    return `<article class="account-tile" data-account-index="${index}"><button type="button" class="account-tile-main" data-open-account="${index}" data-section="settings"><span class="account-tile-top"><span class="account-tile-avatar">${escapeHtml((user.name || '?').slice(0, 1).toUpperCase())}</span><span class="account-tile-title"><strong>${escapeHtml(user.name || '新账号')}</strong><small>${escapeHtml(user.session || '待设置 Session')}</small></span><span class="account-health ${user.sessionReady ? 'ready' : 'pending'}">${user.sessionReady ? '● 正常' : '○ 待登录'}</span></span><span class="account-tile-info"><span><small>Telegram API ID</small><strong>${escapeHtml(user.apiId || config.telegram.apiId || '未设置')}</strong></span><span><small>签到 Bot</small><strong>${user.bots.length} 个</strong></span></span><span class="account-tile-activity"><span>最近运行</span><strong>${latest ? escapeHtml(latest.message) : '暂无定时签到记录'}</strong><small>${latest ? formatDate(latest.time) : `${(user.checkinSchedules || []).length} 个签到计划 · ${messageCount} 个定时消息 · ${forwardCount} 个转发`}</small></span></button><div class="account-tile-actions"><button type="button" data-login-account="${index}" title="Telegram 登录">▣<span>登录</span></button><button type="button" data-run-account="${index}" title="立即签到">▶<span>执行</span></button><button type="button" data-open-account="${index}" data-section="bots" title="签到 Bot">▦<span>Bot</span></button><button type="button" data-open-account="${index}" data-section="checkins" title="定时签到">◷<span>定时</span></button><button type="button" data-open-account="${index}" data-section="messages" title="定时消息">✉<span>消息</span></button><button type="button" data-open-account="${index}" data-section="forwards" title="监听转发">↗<span>转发</span></button><button type="button" data-open-account="${index}" data-section="settings" title="账号资料">✎<span>资料</span></button></div></article>`;
  }).join('') || '<div class="automation-empty">还没有账号。点击右上角添加账号。</div>';
  if (selectedAccountIndex !== null && !config.users[selectedAccountIndex]) selectedAccountIndex = null;
  $('#account-overview').hidden = selectedAccountIndex !== null;
  $('#account-detail').hidden = selectedAccountIndex === null;
  if (selectedAccountIndex !== null) {
    const user = config.users[selectedAccountIndex];
    $('#account-detail-name').textContent = user.name || '新账号';
    $('#account-detail-subtitle').textContent = `${user.sessionReady ? 'Session 已就绪' : '等待登录 Session'} · ${user.bots.length} 个 Bot · ${(user.checkinSchedules || []).length} 个签到计划`;
    $('#account-editor').innerHTML = `<article class="account-card" data-index="${selectedAccountIndex}"><section class="account-pane" data-account-pane="settings"><div class="account-editor-title"><div><h2>账号资料</h2><p>维护 Telegram Session、API 凭据和对话分组。</p></div><button class="delete-btn" data-delete="user" data-index="${selectedAccountIndex}">删除账号</button></div><div class="notice"><span>ⓘ</span><p>先保存全局或账号 API 凭据，再点击登录并使用 Telegram 手机客户端扫码。</p><button type="button" class="outline-btn" data-login-account="${selectedAccountIndex}">登录 Telegram</button></div><div class="field-grid account-fields"><label class="field"><span>显示名称</span><input data-field="name" value="${escapeHtml(user.name)}" placeholder="账号名称"></label><label class="field"><span>Session 名称</span><input data-field="session" value="${escapeHtml(user.session)}" placeholder="例如 myaccount"></label><label class="field"><span>Telegram API ID</span><input data-field="apiId" value="${escapeHtml(user.apiId)}" inputmode="numeric" placeholder="留空继承全局 API ID"></label><label class="field"><span>API Hash</span><input data-field="apiHash" type="password" value="${escapeHtml(user.apiHash || '')}" placeholder="${user.hasApiHash ? '已保存 · 留空保持不变' : '留空继承全局 Hash'}" autocomplete="new-password"></label><label class="field"><span>Telegram 对话分组 <small>可选</small></span><input data-field="dialogFolder" value="${escapeHtml(user.dialogFolder || '')}" placeholder="留空表示全部对话"><small>填写分组名称或数字 ID，仅签到该分组中的 Bot。</small></label></div></section><section class="account-pane" data-account-pane="bots">${renderAccountBots(user, selectedAccountIndex)}</section><section class="account-pane" data-account-pane="checkins">${renderCheckinSchedules(user, selectedAccountIndex)}</section></article>`;
    const fields = $('#account-editor .account-fields');
    const controls = document.createElement('div');
    controls.className = 'notice credential-controls';
    controls.innerHTML = `<div><label><input type="checkbox" data-use-global ${user.useGlobalCredentials ? 'checked' : ''}> 使用全局凭据（保存时清空此账号的 ID / Hash 覆盖）</label><p data-credential-status></p><p>未填写的字段逐项继承全局；已有 Hash 输入留空保持原覆盖。</p><button type="button" class="outline-btn" data-clear-api-hash>清空账号 Hash 覆盖，改用全局 Hash</button></div>`;
    fields.before(controls);
    const updateCredentials = () => {
      const inherited = controls.querySelector('[data-use-global]').checked;
      fields.querySelector('[data-field="apiId"]').disabled = inherited;
      fields.querySelector('[data-field="apiHash"]').disabled = inherited;
      const idOwn = !inherited && Boolean(fields.querySelector('[data-field="apiId"]').value.trim());
      const hashOwn = !inherited && !user.clearApiHash && Boolean(user.hasApiHash || fields.querySelector('[data-field="apiHash"]').value.trim());
      controls.querySelector('[data-credential-status]').textContent = `API ID：${idOwn ? '账号覆盖' : '继承全局'} · API Hash：${hashOwn ? '账号覆盖' : '继承全局'}`;
    };
    controls.querySelector('[data-use-global]').addEventListener('change', updateCredentials);
    fields.querySelector('[data-field="apiId"]').addEventListener('input', updateCredentials);
    fields.querySelector('[data-field="apiHash"]').addEventListener('input', () => { user.clearApiHash = false; updateCredentials(); });
    controls.querySelector('[data-clear-api-hash]').addEventListener('click', () => { user.clearApiHash = true; fields.querySelector('[data-field="apiHash"]').value = ''; fields.querySelector('[data-field="apiHash"]').placeholder = '保存后继承全局 Hash'; updateCredentials(); });
    updateCredentials();
    const deleteAccount = $('#account-editor [data-delete="user"]');
    deleteAccount.disabled = config.users.length === 1;
    if (deleteAccount.disabled) deleteAccount.title = '至少保留一个账号';
    showAccountSection(accountSection);
  }
  $('#provider-list').innerHTML = config.providers.map((provider, index) => `
    <article class="provider-card" data-index="${index}"><div class="card-top"><div class="card-symbol">✧</div><div><strong>${escapeHtml(provider.name || '新服务')}</strong><small>优先级 ${index + 1}</small></div><button class="delete-btn" data-delete="provider" data-index="${index}">删除</button></div>
    <div class="field-grid"><label class="field"><span>服务名称</span><input data-field="name" value="${escapeHtml(provider.name)}" placeholder="例如 primary"></label><label class="field"><span>Base URL</span><input data-field="baseUrl" value="${escapeHtml(provider.baseUrl)}" placeholder="https://api.example.com/v1"></label><label class="field"><span>API Key</span><input data-field="apiKey" type="password" value="${escapeHtml(provider.apiKey || '')}" placeholder="${provider.hasApiKey ? '已保存 · 留空保持不变' : '填写 API Key'}" autocomplete="new-password"></label></div></article>`).join('');
  renderAutomation();
  renderCheckinStatus();
}

function renderCheckinStatus() {
  renderPlannedTimes();
  $$('.checkin-status').forEach(element => {
    const account = config.users[Number(element.dataset.checkinStatus)]?.session;
    const event = checkinSchedulerState?.events?.filter(item => item.account === account).at(-1);
    element.textContent = event ? `最近：${event.message} · ${formatDate(event.time)}` : '';
    element.classList.toggle('error', event?.level === 'error');
  });
}

function accountLabel(session) {
  const user = config.users.find(item => item.session === session);
  return user ? `${user.name} (${user.session})` : '选择账号';
}

function autoSelect(kind, index, field, label) {
  return `<button type="button" class="auto-select-trigger" data-auto-select="${kind}" data-index="${index}" data-field="${field}" role="combobox" aria-label="${label}" aria-haspopup="listbox" aria-expanded="false"><span>${escapeHtml(label)}</span></button>`;
}

function renderAutomation() {
  const account = config.users[selectedAccountIndex]?.session;
  const schedules = config.automations.schedules.map((item, index) => ({ item, index })).filter(entry => entry.item.account === account);
  const forwards = config.automations.forwards.map((item, index) => ({ item, index })).filter(entry => entry.item.account === account);
  $('#schedule-list').innerHTML = schedules.length ? schedules.map(({ item, index }) => `
    <article class="automation-card" data-auto-kind="schedules" data-index="${index}"><div class="automation-card-head"><div class="automation-card-symbol">◷</div><div><strong>定时消息 ${index + 1}</strong><small>${item.repeat === 'once' ? '指定时间发送一次' : '每天定时发送'}</small></div><div class="automation-card-actions"><label class="auto-switch"><input type="checkbox" data-field="enabled" ${item.enabled !== false ? 'checked' : ''}><i></i>启用</label><button class="delete-btn" data-delete="schedule" data-index="${index}">删除</button></div></div>
    <div class="auto-field-grid"><div class="auto-field"><span>发送频率</span>${autoSelect('schedules', index, 'repeat', item.repeat === 'once' ? '发送一次' : '每天发送')}</div>${scheduleTimeFields(item, 'message')}<label class="auto-field wide"><span>目标群组 / 频道</span><input data-field="target" value="${escapeHtml(item.target || '')}" placeholder="@群组用户名 或 -100..." maxlength="120"></label><label class="auto-field wide"><span>消息内容</span><textarea data-field="message" maxlength="4000" placeholder="输入要定时发送的消息">${escapeHtml(item.message || '')}</textarea><small>仅发送纯文本；一次性任务过期超过 5 分钟后不会补发。</small></label></div></article>`).join('') : '<div class="automation-empty">当前账号还没有定时消息。添加规则后，保存即可启用。</div>';
  renderPlannedTimes();
  $('#forward-list').innerHTML = forwards.length ? forwards.map(({ item, index }) => `
    <article class="automation-card" data-auto-kind="forwards" data-index="${index}"><div class="automation-card-head"><div class="automation-card-symbol">↗</div><div><strong>转发规则 ${index + 1}</strong><small>来源有新消息时自动转发</small></div><div class="automation-card-actions"><label class="auto-switch"><input type="checkbox" data-field="enabled" ${item.enabled !== false ? 'checked' : ''}><i></i>启用</label><button class="delete-btn" data-delete="forward" data-index="${index}">删除</button></div></div>
    <div class="auto-field-grid"><label class="auto-field"><span>来源群组 / 频道</span><input data-field="source" value="${escapeHtml(item.source || '')}" placeholder="@来源用户名 或 -100..." maxlength="120"></label><label class="auto-field"><span>转发到</span><input data-field="target" value="${escapeHtml(item.target || '')}" placeholder="@目标用户名 或 -100..." maxlength="120"></label></div></article>`).join('') : '<div class="automation-empty">当前账号还没有转发规则。添加来源与目标后，保存即可开始监听。</div>';
}

function closeAutoSelect() {
  $('#auto-select-menu')?.remove();
  if (openAutoSelect) {
    document.querySelector(`[data-auto-select="${openAutoSelect.kind}"][data-index="${openAutoSelect.index}"][data-field="${openAutoSelect.field}"]`)?.setAttribute('aria-expanded', 'false');
  }
  openAutoSelect = null;
}

function openAutoDropdown(trigger) {
  closeAutoSelect();
  closeModeMenu();
  const kind = trigger.dataset.autoSelect;
  const index = Number(trigger.dataset.index);
  const field = trigger.dataset.field;
  const options = field === 'repeat' ? [{ value:'daily', label:'每天发送' }, { value:'once', label:'发送一次' }] : config.users.map(user => ({ value:user.session, label:accountLabel(user.session) }));
  if (!options.length) { toast('请先添加账号并保存', true); return; }
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(rect.width, 180);
  const menu = document.createElement('div');
  menu.id = 'auto-select-menu';
  menu.className = 'auto-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  menu.style.width = `${width}px`;
  menu.style.top = `${rect.bottom + 6 + Math.min(options.length * 37 + 12, 220) > window.innerHeight ? Math.max(8, rect.top - Math.min(options.length * 37 + 12, 220) - 6) : rect.bottom + 6}px`;
  const current = config.automations[kind][index][field];
  menu.innerHTML = options.map(option => `<button type="button" role="option" data-auto-option="${escapeHtml(option.value)}" aria-selected="${current === option.value}">${escapeHtml(option.label)}</button>`).join('');
  document.body.append(menu);
  trigger.setAttribute('aria-expanded', 'true');
  openAutoSelect = { kind, index, field };
  menu.querySelector('[aria-selected="true"]')?.focus();
}

function chooseAutoOption(value) {
  if (!openAutoSelect) return;
  const { kind, index, field } = openAutoSelect;
  readEditors();
  config.automations[kind][index][field] = value;
  if (field === 'repeat') { config.automations[kind][index].time = ''; if (value === 'once') config.automations[kind][index].timeMode = 'fixed'; }
  closeAutoSelect();
  renderAutomation();
  document.querySelector(`[data-auto-select="${kind}"][data-index="${index}"][data-field="${field}"]`)?.focus();
}

function renderAutomationState() {
  if (!automationState) return;
  const names = { idle:'未启用', starting:'正在启动', running:'运行中', paused:'已暂停', failed:'运行失败', unavailable:'环境未就绪' };
  $('#automation-title').textContent = names[automationState.status] || automationState.status;
  $('#automation-detail').textContent = automationState.message || '';
  $('#automation-since').textContent = automationState.startedAt ? `启动于 ${formatDate(automationState.startedAt)}` : '—';
  $('#automation-indicator').className = `run-indicator ${automationState.status === 'running' ? 'running' : automationState.status === 'failed' ? 'failed' : ''}`;
  const lines = automationState.lines || [];
  $('#automation-log-lines').innerHTML = lines.length ? lines.slice(-20).reverse().map(item => `<div class="automation-log-row ${item.level === 'error' ? 'error' : ''}"><time>${new Date(item.time).toLocaleString('zh-CN',{hour12:false})}</time><span>${escapeHtml(item.message)}</span></div>`).join('') : '<div class="automation-empty">暂无运行记录</div>';
}

function closeModeMenu() {
  const menu = $('#mode-menu');
  if (menu) menu.remove();
  if (openModeIndex !== null) {
    const trigger = document.querySelector(`[data-mode-trigger="${openModeIndex}"]`);
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  openModeIndex = null;
}

function openModeMenu(key) {
  closeModeMenu();
  const trigger = document.querySelector(`[data-mode-trigger="${key}"]`);
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(rect.width, 184);
  const top = rect.bottom + 7 + 116 > window.innerHeight ? rect.top - 116 - 7 : rect.bottom + 7;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const menu = document.createElement('div');
  menu.id = 'mode-menu';
  menu.className = 'mode-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', '签到方式');
  menu.style.cssText = `top:${top}px;left:${left}px;width:${width}px`;
  const [accountIndex, botIndex] = key.split(':').map(Number);
  const current = config.users[accountIndex].bots[botIndex].mode;
  menu.innerHTML = `<button type="button" role="option" aria-selected="${current === 'button'}" data-mode-option="button"><span class="menu-option-icon">↖</span><span><strong>点击按钮</strong><small>发送 /start 后点击签到</small></span><span class="selected-mark">✓</span></button><button type="button" role="option" aria-selected="${current === 'command'}" data-mode-option="command"><span class="menu-option-icon">⌘</span><span><strong>发送命令</strong><small>向 Bot 发送指定命令</small></span><span class="selected-mark">✓</span></button>`;
  document.body.append(menu);
  trigger.setAttribute('aria-expanded', 'true');
  openModeIndex = key;
  menu.querySelector('[aria-selected="true"]').focus();
}

function chooseMode(mode) {
  if (openModeIndex === null) return;
  const key = openModeIndex;
  const [accountIndex, botIndex] = key.split(':').map(Number);
  config.users[accountIndex].bots[botIndex].mode = mode;
  const trigger = document.querySelector(`[data-mode-trigger="${key}"]`);
  trigger.querySelector('.mode-icon').textContent = mode === 'command' ? '⌘' : '↖';
  trigger.querySelector('.mode-label').textContent = mode === 'command' ? '发送命令' : '点击按钮';
  trigger.closest('tr').querySelector('[data-field="command"]').disabled = mode === 'button';
  closeModeMenu();
  trigger.focus();
}

function readEditors() {
  config.telegram ||= {};
  config.telegram.apiId = $('#global-api-id').value;
  config.telegram.apiHash = $('#global-api-hash').value;
  $$('#account-editor .account-card').forEach(card => {
    const item = config.users[Number(card.dataset.index)];
    const previousSession = item.session;
    item.useGlobalCredentials = card.querySelector('[data-use-global]').checked;
    card.querySelectorAll('.account-fields [data-field]').forEach(input => { item[input.dataset.field] = input.value; });
    if (item.session !== previousSession) {
      for (const kind of ['schedules', 'forwards']) config.automations[kind].forEach(rule => { if (rule.account === previousSession) rule.account = item.session; });
    }
    card.querySelectorAll('.account-bot-table tr[data-bot-index]').forEach(row => {
      const bot = item.bots[Number(row.dataset.botIndex)];
      row.querySelectorAll('[data-field]').forEach(input => { bot[input.dataset.field] = input.value; });
    });
    card.querySelectorAll('.checkin-rule[data-checkin-index]').forEach(row => {
      const schedule = item.checkinSchedules[Number(row.dataset.checkinIndex)];
      row.querySelectorAll('[data-field]').forEach(input => { schedule[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value; });
    });
  });
  $$('#provider-list article').forEach(card => {
    const item = config.providers[Number(card.dataset.index)];
    card.querySelectorAll('[data-field]').forEach(input => { item[input.dataset.field] = input.value; });
  });
  $$('.automation-card[data-auto-kind]').forEach(card => {
    const item = config.automations[card.dataset.autoKind][Number(card.dataset.index)];
    card.querySelectorAll('input[data-field],textarea[data-field],select[data-field]').forEach(input => { item[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value; });
  });
  config.model = $('#model-input').value;
}

async function saveConfig() {
  readEditors();
  try {
    const data = await api('/api/config', { method:'POST', body:JSON.stringify(config) });
    config = data.config;
    automationState = data.automation;
    checkinSchedulerState = data.checkinScheduler;
    renderConfig();
    renderAutomationState();
    renderCheckinStatus();
    toast('配置已保存，下次运行时生效');
  } catch (error) { toast(error.message, true); }
}

async function startRun(account = null) {
  try {
    await api('/api/run', { method:'POST', body:JSON.stringify(account ? { account } : {}) });
    toast(account ? `${account} 的签到任务已启动` : '签到任务已启动');
    navigate('activity');
    await poll();
  } catch (error) { toast(error.message, true); }
}

async function stopRun() {
  try {
    await api('/api/stop', { method:'POST', body:'{}' });
    toast('正在停止任务');
    await poll();
  } catch (error) { toast(error.message, true); }
}

function renderRun() {
  if (!currentRun) return;
  const state = currentRun.state;
  $('#stat-status').textContent = statusText[state] || state;
  $('#stat-last').textContent = currentRun.startedAt ? `启动于 ${formatDate(currentRun.startedAt)}` : '尚无运行记录';
  $('#run-title').textContent = statusText[state] || state;
  $('#run-detail').textContent = state === 'idle' ? (pythonVersion ? '配置完成后，即可启动批量签到。' : '未找到 Python，请先安装运行环境。') : state === 'running' ? '正在处理账号和 Bot，请保持服务运行。' : state === 'completed' ? '本次任务已结束，可查看下方完整输出。' : state === 'stopping' ? '正在等待脚本退出。' : '请查看日志中的错误信息。';
  $('#run-indicator').className = `run-indicator ${state}`;
  $('#run-meta').textContent = currentRun.startedAt ? `开始：${formatDate(currentRun.startedAt)}${currentRun.finishedAt ? ` · 结束：${formatDate(currentRun.finishedAt)}` : ''}` : '—';
  $('#stop-run').disabled = !['running','stopping'].includes(state);
  $$('#hero-run,#activity-run').forEach(button => { button.disabled = ['running','stopping'].includes(state) || (typeof loginState !== 'undefined' && loginState?.active); });
  const lines = currentRun.lines || [];
  $('#log-count').textContent = `${lines.length} 行`;
  const consoleEl = $('#log-console');
  if (!lines.length) {
    consoleEl.innerHTML = '<div class="log-empty">运行日志会显示在这里。</div>';
    lastLogId = 0;
  } else if (lines.at(-1).id !== lastLogId) {
    const nearBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 80;
    consoleEl.innerHTML = lines.map(line => `<div class="log-line ${line.stream}"><time>${new Date(line.time).toLocaleTimeString('zh-CN',{hour12:false})}</time><span>${escapeHtml(line.text)}</span></div>`).join('');
    if (nearBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
    lastLogId = lines.at(-1).id;
  }
  const latest = $('#latest-activity');
  if (lines.length) latest.className = 'latest-lines', latest.innerHTML = lines.slice(-5).reverse().map(line => `<div class="latest-line"><time>${new Date(line.time).toLocaleTimeString('zh-CN',{hour12:false})}</time><span>${escapeHtml(line.text)}</span></div>`).join('');
}

async function poll() {
  try {
    const data = await api('/api/state');
    currentRun = data.run;
    automationState = data.automation;
    checkinSchedulerState = data.checkinScheduler;
    pythonVersion = data.python;
    renderRun();
    renderAutomationState();
    renderCheckinStatus();
  } catch (error) { console.error(error); }
}

document.addEventListener('click', event => {
  const runAccountButton = event.target.closest('[data-run-account]');
  if (runAccountButton) { const account = config.users[Number(runAccountButton.dataset.runAccount)]?.session; if (account) startRun(account); return; }
  const accountLink = event.target.closest('[data-open-account]');
  if (accountLink) { openAccount(Number(accountLink.dataset.openAccount), accountLink.dataset.section || 'settings'); return; }
  const sectionLink = event.target.closest('#account-tabs [data-account-section]');
  if (sectionLink) { readEditors(); showAccountSection(sectionLink.dataset.accountSection); return; }
  const autoOption = event.target.closest('[data-auto-option]');
  if (autoOption) { chooseAutoOption(autoOption.dataset.autoOption); return; }
  const autoTrigger = event.target.closest('[data-auto-select]');
  if (autoTrigger) {
    const isOpen = openAutoSelect && openAutoSelect.kind === autoTrigger.dataset.autoSelect && openAutoSelect.index === Number(autoTrigger.dataset.index) && openAutoSelect.field === autoTrigger.dataset.field;
    isOpen ? closeAutoSelect() : openAutoDropdown(autoTrigger);
    return;
  }
  if (!event.target.closest('#auto-select-menu')) closeAutoSelect();
  const option = event.target.closest('[data-mode-option]');
  if (option) { chooseMode(option.dataset.modeOption); return; }
  const trigger = event.target.closest('[data-mode-trigger]');
  if (trigger) { const key = trigger.dataset.modeTrigger; openModeIndex === key ? closeModeMenu() : openModeMenu(key); return; }
  if (!event.target.closest('#mode-menu')) closeModeMenu();
  const nav = event.target.closest('[data-view],[data-go]');
  if (nav) { navigate(nav.dataset.view || nav.dataset.go); return; }
  const del = event.target.closest('[data-delete]');
  if (del) {
    readEditors();
    const field = ({ user:'users', provider:'providers' })[del.dataset.delete];
    if (del.dataset.delete === 'bot') config.users[Number(del.dataset.accountIndex)].bots.splice(Number(del.dataset.index), 1);
    else if (del.dataset.delete === 'checkin') config.users[Number(del.dataset.accountIndex)].checkinSchedules.splice(Number(del.dataset.index), 1);
    else if (field) {
      if (field === 'users') {
        const session = config.users[Number(del.dataset.index)].session;
        config.automations.schedules = config.automations.schedules.filter(item => item.account !== session);
        config.automations.forwards = config.automations.forwards.filter(item => item.account !== session);
        selectedAccountIndex = null;
      }
      config[field].splice(Number(del.dataset.index), 1);
    }
    else config.automations[del.dataset.delete === 'schedule' ? 'schedules' : 'forwards'].splice(Number(del.dataset.index), 1);
    renderConfig();
  }
  const addBot = event.target.closest('[data-add-bot]');
  if (addBot) {
    readEditors();
    const index = Number(addBot.dataset.addBot);
    config.users[index].bots.push({ name:'', mode:'button', command:'/sign', note:'' });
    renderConfig();
    document.querySelector(`#account-editor .account-bot-table tr:last-child input`)?.focus();
  }
  const addCheckin = event.target.closest('[data-add-checkin]');
  if (addCheckin) {
    readEditors();
    const index = Number(addCheckin.dataset.addCheckin);
    config.users[index].checkinSchedules ||= [];
    config.users[index].checkinSchedules.push({ id:crypto.randomUUID(), enabled:true, repeat:'daily', time:'09:00' });
    renderConfig();
    document.querySelector(`#account-editor .checkin-rule:last-child input[data-field="time"]`)?.focus();
  }
  const repeatButton = event.target.closest('[data-checkin-repeat]');
  if (repeatButton) {
    readEditors();
    const accountIndex = Number(repeatButton.dataset.accountIndex);
    const index = Number(repeatButton.dataset.index);
    const rule = config.users[accountIndex].checkinSchedules[index];
    if (rule.repeat !== repeatButton.dataset.checkinRepeat) {
      rule.repeat = repeatButton.dataset.checkinRepeat;
      rule.time = rule.repeat === 'daily' ? '09:00' : '';
      if (rule.repeat === 'once') rule.timeMode = 'fixed';
      renderConfig();
      document.querySelector(`#account-editor .checkin-rule[data-checkin-index="${index}"] input[data-field="time"]`)?.focus();
    }
  }
});
document.addEventListener('change', event => {
  if (!event.target.matches('[data-time-mode]')) return;
  readEditors();
  const row = event.target.closest('.checkin-rule,.automation-card');
  const rule = event.target.dataset.timeMode === 'checkin'
    ? config.users[selectedAccountIndex].checkinSchedules[Number(row.dataset.checkinIndex)]
    : config.automations.schedules[Number(row.dataset.index)];
  rule.rangeStart ||= '09:00:00'; rule.rangeEnd ||= '10:30:00';
  renderConfig();
});
document.addEventListener('keydown', event => {
  const autoTrigger = event.target.closest('[data-auto-select]');
  if (autoTrigger && ['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    openAutoDropdown(autoTrigger);
    return;
  }
  if (openAutoSelect && event.key === 'Escape') {
    event.preventDefault();
    const { kind, index, field } = openAutoSelect;
    closeAutoSelect();
    document.querySelector(`[data-auto-select="${kind}"][data-index="${index}"][data-field="${field}"]`)?.focus();
    return;
  }
  if (openAutoSelect && event.target.closest('#auto-select-menu') && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const options = $$('#auto-select-menu [data-auto-option]');
    const step = event.key === 'ArrowDown' ? 1 : -1;
    options[(options.indexOf(event.target) + step + options.length) % options.length].focus();
    return;
  }
  const trigger = event.target.closest('[data-mode-trigger]');
  if (trigger && ['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    openModeMenu(trigger.dataset.modeTrigger);
    return;
  }
  if (openModeIndex === null) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    const key = openModeIndex;
    closeModeMenu();
    document.querySelector(`[data-mode-trigger="${key}"]`)?.focus();
  } else if (event.target.closest('#mode-menu') && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const options = $$('#mode-menu [data-mode-option]');
    const step = event.key === 'ArrowDown' ? 1 : -1;
    options[(options.indexOf(event.target) + step + options.length) % options.length].focus();
  }
});
window.addEventListener('scroll', () => { closeModeMenu(); closeAutoSelect(); }, true);
window.addEventListener('resize', () => { closeModeMenu(); closeAutoSelect(); });
$('#add-account').addEventListener('click', () => { readEditors(); config.users.push({ sourceIndex:-1, name:'', session:'', apiId:'', apiHash:'', hasApiHash:false, sessionReady:false, dialogFolder:'', bots:[], checkinSchedules:[] }); openAccount(config.users.length - 1); $('#account-editor .account-fields input')?.focus(); });
$('#account-back').addEventListener('click', () => navigate('accounts'));
$('#add-provider').addEventListener('click', () => { readEditors(); config.providers.push({ sourceIndex:-1, name:'', baseUrl:'', apiKey:'', hasApiKey:false }); renderConfig(); $('#provider-list article:last-child input').focus(); });
$('#add-schedule').addEventListener('click', () => { readEditors(); config.automations.schedules.push({ id:crypto.randomUUID(), enabled:true, account:config.users[selectedAccountIndex]?.session || '', target:'', repeat:'daily', time:'09:00', message:'' }); renderAutomation(); $('#schedule-list article:last-child input[data-field="target"]')?.focus(); });
$('#add-forward').addEventListener('click', () => { readEditors(); config.automations.forwards.push({ id:crypto.randomUUID(), enabled:true, account:config.users[selectedAccountIndex]?.session || '', source:'', target:'' }); renderAutomation(); $('#forward-list article:last-child input[data-field="source"]')?.focus(); });
$('#restart-automation').addEventListener('click', async () => {
  try { const data = await api('/api/automation/restart', { method:'POST', body:'{}' }); automationState = data.automation; renderAutomationState(); toast('自动化已重新启动'); }
  catch (error) { toast(error.message, true); }
});
$$('.save-btn').forEach(button => button.addEventListener('click', saveConfig));
$('#hero-run').addEventListener('click', () => startRun());
$('#activity-run').addEventListener('click', () => startRun());
$('#account-run').addEventListener('click', () => { const account = config.users[selectedAccountIndex]?.session; if (account) startRun(account); });
$('#stop-run').addEventListener('click', stopRun);
$('#today').textContent = new Date().toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric', weekday:'long' });

(async () => {
  try {
    const data = await api('/api/state');
    config = data.config;
    currentRun = data.run;
    automationState = data.automation;
    checkinSchedulerState = data.checkinScheduler;
    pythonVersion = data.python;
    renderConfig();
    renderRun();
    renderAutomationState();
    const hash = location.hash.slice(1);
    if (['overview','bots','accounts','ai','automation','activity'].includes(hash)) navigate(hash);
    if (!pythonVersion) toast('未检测到 Python，配置可编辑，运行需安装 Python 环境', true);
    setInterval(poll, 2000);
  } catch (error) { toast(`加载失败：${error.message}`, true); }
})();
