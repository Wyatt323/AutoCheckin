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
    if (filter.account && (run.account || '__all__') !== filter.account) continue;
    if (filter.status && run.state !== filter.status) continue;
    for (const line of run.lines || []) {
      const parts = beijingParts(line.time);
      if (!parts || (filter.date && parts.date !== filter.date) || (start && parts.time < start) || (end && parts.time > end)) continue;
      rows.push({ ...line, runId: run.id, account: run.account, state: run.state, trigger: run.trigger });
    }
  }
  return rows;
}
if (typeof module !== 'undefined') module.exports = { beijingParts, filterRunLogs };
if (typeof document !== 'undefined') {
  let runRecords = [], modalRunId = null, lastRevision = -1, polling = false;
  const dialog = document.createElement('dialog');
  dialog.id = 'run-log-dialog';
  dialog.setAttribute('aria-labelledby', 'run-log-title');
  dialog.innerHTML = '<div class="run-modal-head"><h2 id="run-log-title">本次执行日志</h2><button id="run-log-close" class="outline-btn" type="button" aria-label="关闭执行日志">关闭</button></div><p id="run-log-target"></p><p id="run-log-status" role="status" aria-live="polite"></p><div id="run-log-output" class="log-console"></div><div class="run-modal-foot"><small>关闭窗口不会停止任务；日志按北京时间显示。</small><button id="run-log-stop" class="danger-btn" type="button">停止本次任务</button></div><p id="run-log-error" role="alert"></p>';
  document.body.append(dialog);
  const filters = document.createElement('form');
  filters.id = 'log-filters'; filters.className = 'log-filters';
  filters.innerHTML = `<label>日期 · 北京时间<input id="log-filter-date" type="date"></label><label>开始时间<input id="log-filter-start" type="time" step="1"></label><label>结束时间<input id="log-filter-end" type="time" step="1"></label><label>账号<select id="log-filter-account"><option value="">所有账号</option><option value="__all__">全部账号（批量执行）</option></select></label><label>运行状态<select id="log-filter-status"><option value="">所有状态</option>${Object.entries(statusText).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><button class="outline-btn" type="reset">重置筛选</button><small>按每行日志时间筛选；状态为所属任务状态，批量执行不冒充单账号日志。</small>`;
  $('#log-console').before(filters);
  filters.addEventListener('submit', event => event.preventDefault());
  filters.addEventListener('input', renderHistory);
  filters.addEventListener('change', renderHistory);
  filters.addEventListener('reset', () => { queueMicrotask(renderHistory); });
  function labelFor(run) {
    if (!run.account) return '全部账号（批量执行）';
    const user = config?.users.find(user => user.session === run.account);
    return user ? `${user.name} (${run.account})` : run.account;
  }
  function lineHtml(line, detailed = false) {
    const parts = beijingParts(line.time);
    return `<div class="log-line ${escapeHtml(line.stream)}"><time>${parts ? (detailed ? `${parts.date} ` : '') + parts.time : '—'}</time><span>${detailed ? `<b class="log-scope">${escapeHtml(labelFor(line))} · ${escapeHtml(statusText[line.state] || line.state)} · ${line.trigger === 'scheduled' ? '定时' : '手动'}</b>` : ''}${escapeHtml(line.text)}</span></div>`;
  }
  function setOutput(element, html) {
    if (element.innerHTML === html) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    element.innerHTML = html;
    if (bottom) element.scrollTop = element.scrollHeight;
  }
  function updateAccounts() {
    const select = $('#log-filter-account');
    const accounts = [...new Set([...runRecords.map(run => run.account), ...(config?.users || []).map(user => user.session)].filter(Boolean))].sort();
    // Append only missing options: polling must not replace focused filter controls.
    for (const account of accounts) {
      if ([...select.options].some(option => option.value === account)) continue;
      const option = document.createElement('option'); option.value = account;
      option.textContent = labelFor({ account }); select.append(option);
    }
  }
  function renderHistory() {
    const filter = { date: $('#log-filter-date').value, start: $('#log-filter-start').value, end: $('#log-filter-end').value, account: $('#log-filter-account').value, status: $('#log-filter-status').value };
    const rows = filterRunLogs(runRecords, filter);
    $('#log-count').textContent = `${rows.length} 行 · ${runRecords.length} 次执行`;
    const invalid = filter.start && filter.end && filter.start > filter.end;
    setOutput($('#log-console'), rows.length ? rows.map(row => lineHtml(row, true)).join('') : `<div class="log-empty">${invalid ? '开始时间不能晚于结束时间。' : '没有符合筛选条件的日志。'}</div>`);
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
    if (!dialog.open) dialog.showModal();
    renderModal(); refreshRunLogs();
  };
  window.refreshRunLogs = async () => {
    if (polling) return;
    polling = true;
    try {
      const data = await api('/api/runs');
      if (lastRevision !== data.revision) { runRecords = data.records; lastRevision = data.revision; }
      updateAccounts(); renderHistory(); renderModal();
    } catch (error) { if (dialog.open) $('#run-log-error').textContent = `日志读取失败：${error.message}`; }
    finally { polling = false; }
  };
  $('#run-log-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  $('#run-log-stop').addEventListener('click', async () => {
    if (!confirm('确定停止本次签到任务？关闭日志窗口不会停止任务。')) return;
    try {
      await api('/api/stop', { method: 'POST', body: JSON.stringify({ id: modalRunId }) });
      $('#run-log-stop').disabled = true; await poll();
    } catch (error) { $('#run-log-error').textContent = error.message; }
  });
  refreshRunLogs();
}
