// Filters use log timestamps in Beijing time, independent of browser timezone.
function beijingParts(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const text = new Date(date.getTime() + 28800000).toISOString();
  return { date: text.slice(0, 10), time: text.slice(11, 19) };
}
function filterRunLogs(records, filter) {
  const rows = [];
  const start = filter.start && (filter.start.length === 5 ? `${filter.start}:00` : filter.start);
  const end = filter.end && (filter.end.length === 5 ? `${filter.end}:59` : filter.end);
  if (start && end && start > end) return rows;
  for (const run of records) {
    const category = run.category || 'checkin';
    if (filter.category && category !== filter.category) continue;
    if (filter.account === '__all__' && run.account) continue;
    for (const line of run.lines || []) {
      const account = line.account || run.account;
      const state = typeof run.accountStates?.[account] === 'string' ? run.accountStates[account] : run.state;
      if (filter.account && filter.account !== '__all__' && account !== filter.account) continue;
      if (filter.status && state !== filter.status) continue;
      const parts = beijingParts(line.time);
      if (!parts || (filter.date && parts.date !== filter.date) || (start && parts.time < start) || (end && parts.time > end)) continue;
      rows.push({ ...line, runId: run.id, account, state, trigger: run.trigger, category, bot:run.bot });
    }
  }
  return rows.sort((a,b) => Date.parse(a.time) - Date.parse(b.time));
}
if (typeof module !== 'undefined') module.exports = { beijingParts, filterRunLogs };
if (typeof document !== 'undefined') {
  let runRecords = [], modalRunId = null, lastRevision = -1, polling = false, logScope = null, lastQuery = null;
  const categories = {checkin:'定时任务', message:'定时消息', forward:'监听转发'};
  const dialog = document.createElement('dialog');
  dialog.id = 'run-log-dialog';
  dialog.setAttribute('aria-labelledby', 'run-log-title');
  dialog.innerHTML = '<div class="run-modal-head"><h2 id="run-log-title">本次执行日志</h2><button id="run-log-close" class="outline-btn" type="button" aria-label="关闭执行日志">关闭</button></div><p id="run-log-target"></p><p id="run-log-status" role="status" aria-live="polite"></p><div id="run-log-output" class="log-console"></div><div class="run-modal-foot"><small>关闭窗口不会停止任务；日志按北京时间显示。</small><button id="run-log-stop" class="danger-btn" type="button">停止本次任务</button></div><p id="run-log-error" role="alert"></p>';
  document.body.append(dialog);
  const historyContent = $('#log-history-content');
  const historyHome = historyContent.parentElement;
  const accountDialog = document.createElement('dialog');
  accountDialog.id = 'account-log-dialog';
  accountDialog.setAttribute('aria-labelledby', 'log-page-title');
  accountDialog.innerHTML = '<div class="account-log-toolbar"><span class="kicker">ACCOUNT ACTIVITY</span><button id="account-log-close" class="outline-btn" type="button" aria-label="关闭账号日志" autofocus>关闭</button></div>';
  document.body.append(accountDialog);
  const filters = document.createElement('form');
  filters.id = 'log-filters'; filters.className = 'log-filters';
  filters.innerHTML = `<label>日志分类<select id="log-filter-category"><option value="">全部分类</option>${Object.entries(categories).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label>账号<select id="log-filter-account"><option value="">所有账号</option><option value="__all__">全部账号（批量执行）</option></select></label><label>日期 · 北京时间<input id="log-filter-date" type="date"></label><label>开始时间<input id="log-filter-start" type="time" step="1"></label><label>结束时间<input id="log-filter-end" type="time" step="1"></label><label>运行状态<select id="log-filter-status"><option value="">所有状态</option>${Object.entries(statusText).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><div class="log-filter-actions"><button class="primary-btn" type="submit">筛选</button><button class="outline-btn" type="reset">重置筛选</button></div><small id="log-scope-hint">定时任务包含账号与 Bot 签到（含手动执行）；按每条日志的北京时间筛选。</small>`;
  $('#log-console').before(filters);
  filters.addEventListener('submit', event => { event.preventDefault(); renderHistory(); refreshRunLogs(); });
  filters.addEventListener('input', renderHistory);
  filters.addEventListener('change', renderHistory);
  filters.addEventListener('reset', () => { setTimeout(() => { $('#log-filter-account').value = logScope || ''; renderHistory(); if (typeof UIControls !== 'undefined') UIControls.refresh(); }, 0); });
  window.setRunLogScope = account => {
    logScope = account || null;
    filters.reset();
    updateAccounts();
    const select = $('#log-filter-account');
    select.value = logScope || '';
    select.disabled = Boolean(logScope);
    const user = config?.users.find(user => user.session === logScope);
    $('#log-page-title').textContent = logScope ? `${user?.name || logScope} · 运行日志` : '运行日志';
    $('#log-page-description').textContent = logScope ? '仅显示当前账号的定时任务、定时消息和监听转发记录。' : '查看全部账号的定时任务、定时消息和监听转发记录。';
    $('#log-back').hidden = !logScope || accountDialog.contains(historyContent);
    $('#log-error').hidden = true;
    // Drop the previous account's result immediately; revision alone is not a scope identity.
    runRecords = []; lastRevision = -1; lastQuery = null;
    renderHistory();
    if (typeof UIControls !== 'undefined') UIControls.refresh();
  };
  window.openAccountLogs = account => {
    if (typeof UIControls !== 'undefined') UIControls.close();
    accountDialog.append(historyContent);
    setRunLogScope(account);
    if (typeof UIControls !== 'undefined') UIControls.refresh();
    accountDialog.showModal();
    refreshRunLogs();
  };
  const closeAccountLogs = () => {
    if (typeof UIControls !== 'undefined') UIControls.close();
    accountDialog.close();
  };
  $('#account-log-close').addEventListener('click', closeAccountLogs);
  accountDialog.addEventListener('cancel', event => { event.preventDefault(); closeAccountLogs(); });
  accountDialog.addEventListener('close', () => {
    if (accountDialog.open) return; // Ignore a queued close event after an immediate reopen.
    historyHome.append(historyContent);
    setRunLogScope(null);
    refreshRunLogs();
  });
  $('#log-back').addEventListener('click', () => {
    const index = config?.users.findIndex(user => user.session === logScope);
    if (index >= 0) openAccount(index); else navigate('accounts');
  });
  function labelFor(run) {
    if (!run.account) return '全部账号（批量执行）';
    const user = config?.users.find(user => user.session === run.account);
    return (user ? `${user.name} (${run.account})` : run.account) + (run.bot ? ` · ${run.bot}` : '');
  }
  function lineHtml(line, detailed = false) {
    const parts = beijingParts(line.time);
    return `<div class="log-line ${escapeHtml(line.stream)}"><time>${parts ? (detailed ? `${parts.date} ` : '') + parts.time : '—'}</time><span>${detailed ? `<b class="log-scope">${escapeHtml(labelFor(line))} · ${categories[line.category] || '定时任务'} · ${escapeHtml(statusText[line.state] || line.state)}${line.category === 'checkin' ? ` · ${line.trigger === 'scheduled' ? '定时' : '手动'}` : ''}</b>` : ''}${escapeHtml(line.text)}</span></div>`;
  }
  function setOutput(element, html) {
    if (element.dataset.output === html) return;
    element.dataset.output = html;
    if (element.innerHTML === html) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    element.innerHTML = html;
    if (bottom) element.scrollTop = element.scrollHeight;
  }
  function updateAccounts() {
    const select = $('#log-filter-account');
    const accounts = [...new Set([logScope, ...runRecords.flatMap(run => [run.account, ...run.lines.map(line => line.account)]), ...(config?.users || []).map(user => user.session)].filter(Boolean))].sort();
    // Append only missing options: polling must not replace focused filter controls.
    for (const account of accounts) {
      if ([...select.options].some(option => option.value === account)) continue;
      const option = document.createElement('option'); option.value = account;
      option.textContent = labelFor({ account }); select.append(option);
    }
  }
  function renderHistory() {
    const filter = { date: $('#log-filter-date').value, start: $('#log-filter-start').value, end: $('#log-filter-end').value, account: logScope || $('#log-filter-account').value, status: $('#log-filter-status').value, category:$('#log-filter-category').value };
    const rows = filterRunLogs(runRecords, filter);
    $('#log-count').textContent = `${rows.length} 行 · ${new Set(rows.map(row => row.runId)).size} 条记录`;
    const invalid = filter.start && filter.end && filter.start > filter.end;
    setOutput($('#log-console'), rows.length ? rows.map(row => lineHtml(row, true)).join('') : `<div class="log-empty">${invalid ? '开始时间不能晚于结束时间。' : lastQuery === null ? '正在加载日志…' : '没有符合筛选条件的日志。'}</div>`);
  }
  function renderModal() {
    if (!dialog.open) return;
    const run = runRecords.find(run => run.id === modalRunId);
    if (!run) { $('#run-log-status').textContent = '此记录已超出保留范围'; $('#run-log-stop').disabled = true; return; }
    $('#run-log-target').textContent = `${labelFor(run)} · ${run.trigger === 'scheduled' ? '定时执行' : '手动执行'} · ${formatDate(run.startedAt)}`;
    $('#run-log-status').textContent = `${statusText[run.state] || run.state}${run.finishedAt ? ` · 结束：${formatDate(run.finishedAt)}` : ''}`;
    $('#run-log-stop').disabled = run.state !== 'running';
    setOutput($('#run-log-output'), run.lines.length ? run.lines.map(line => lineHtml(line)).join('') : '<div class="log-empty">等待任务输出…</div>');
  }
  window.openRunLog = run => {
    modalRunId = run.id;
    const index = runRecords.findIndex(record => record.id === run.id);
    if (index < 0) runRecords.push(run); else runRecords[index] = run;
    $('#run-log-error').textContent = '';
    if (!dialog.open || dialog.classList.contains('ui-dialog-closing')) dialog.showModal();
    renderModal(); refreshRunLogs();
  };
  const currentQuery = () => (accountDialog.open || currentView === 'activity') && logScope && !dialog.open ? `?account=${encodeURIComponent(logScope)}` : '';
  window.refreshRunLogs = async () => {
    if (polling || (!dialog.open && !accountDialog.open && currentView !== 'activity')) return;
    polling = true;
    const query = currentQuery();
    try {
      const data = await api(`/api/runs${query}`);
      if (query !== currentQuery()) return;
      if (lastRevision !== data.revision || lastQuery !== query) { runRecords = data.records; lastRevision = data.revision; lastQuery = query; }
      $('#log-error').hidden = true;
      updateAccounts(); renderHistory(); renderModal();
    } catch (error) { if (dialog.open) $('#run-log-error').textContent = `日志读取失败：${error.message}`; else { $('#log-error').hidden = false; $('#log-error').textContent = `日志读取失败：${error.message}`; } }
    finally { polling = false; if (query !== currentQuery()) refreshRunLogs(); }
  };
  $('#run-log-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  $('#run-log-stop').addEventListener('click', async () => {
    const runId = modalRunId;
    const accepted = typeof UIControls !== 'undefined' ? await UIControls.confirm({ title:'停止本次签到', message:'确定停止本次签到任务？关闭日志窗口不会停止任务。', confirmText:'停止任务' }) : confirm('确定停止本次签到任务？关闭日志窗口不会停止任务。');
    if (!accepted) return;
    try {
      await api('/api/stop', { method: 'POST', body: JSON.stringify({ id: runId }) });
      $('#run-log-stop').disabled = true; await poll();
    } catch (error) { $('#run-log-error').textContent = error.message; }
  });
  refreshRunLogs();
}
