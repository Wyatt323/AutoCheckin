(() => {
  let snapshot = null, generation = 0;
  const userSelect = $('#audit-user'), accountSelect = $('#audit-account');
  function clear(message) {
    snapshot = null;
    $('#audit-log-count').textContent = '0 行';
    $('#audit-log-output').innerHTML = '<div class="log-empty">' + escapeHtml(message) + '</div>';
    $('#audit-bots').innerHTML = '<div class="automation-empty">' + escapeHtml(message) + '</div>';
    $('#audit-summary').textContent = message;
    $('#audit-error').hidden = true;
  }
  function error(message) {
    $('#audit-error').textContent = message; $('#audit-error').hidden = false;
  }
  window.loadAuditUsers = async () => {
    if (webUser?.role !== 'admin') return;
    const request = ++generation, selected = userSelect.value;
    clear('正在加载用户列表…');
    try {
      const data = await api('/api/admin/audit/users');
      if (request !== generation) return;
      userSelect.innerHTML = '<option value="">请选择用户</option>' + data.users.map(user=>'<option value="'+escapeHtml(user.id)+'">'+escapeHtml(user.username)+'</option>').join('');
      userSelect.value = data.users.some(user=>user.id === selected) ? selected : '';
      if (typeof UIControls !== 'undefined') UIControls.refresh();
      if (userSelect.value) await loadSnapshot();
      else {
        accountSelect.innerHTML = '<option value="">所有账号</option>';
        clear(data.users.length ? '请选择要查看的用户。' : '还没有可审计的用户。');
      }
    } catch (e) { if (request === generation) {clear('用户列表加载失败。');error(e.message);} }
  };
  async function loadSnapshot() {
    const request = ++generation, userId = userSelect.value, account = accountSelect.value;
    clear(userId ? '正在加载审计数据…' : '请选择要查看的用户。');
    if (!userId) return;
    try {
      const data = await api('/api/admin/audit/users/' + encodeURIComponent(userId) + (account ? '?account='+encodeURIComponent(account) : ''));
      if (request !== generation || userSelect.value !== userId) return;
      snapshot = data;
      const accounts = new Map(data.accounts.map(item=>[item.session,item.name || item.session]));
      for (const session of data.logAccounts || []) if (!accounts.has(session)) accounts.set(session,session+'（历史账号）');
      accountSelect.innerHTML = '<option value="">所有账号</option>' + [...accounts].map(([session,name])=>'<option value="'+escapeHtml(session)+'">'+escapeHtml(name)+' · '+escapeHtml(session)+'</option>').join('');
      accountSelect.value = accounts.has(account) ? account : '';
      $('#audit-summary').textContent = data.user.username + ' · ' + data.accounts.length + ' 个 Telegram 账号 · 更新于 ' + formatDate(new Date().toISOString());
      render();
      if (typeof UIControls !== 'undefined') UIControls.refresh();
    } catch (e) {if (request === generation) {clear('审计数据加载失败，请刷新重试。');error(e.message);}}
  }
  function render() {
    if (!snapshot) return;
    const account = accountSelect.value;
    const rows = filterRunLogs(snapshot.records,{account,date:$('#audit-date').value,status:$('#audit-status').value},snapshot.accounts);
    const names = new Map(snapshot.accounts.map(item=>[item.session,item.name]));
    $('#audit-log-count').textContent = rows.length + ' 行';
    $('#audit-log-output').innerHTML = runLogGroupsHtml(rows,line=>names.get(line.account) || line.account || '批量任务') || '<div class="log-empty">当前筛选下没有签到日志。</div>';
    const selected = snapshot.accounts.filter(item=>!account || item.session === account);
    $('#audit-bots').innerHTML = selected.map(item=>{
      const folder = Boolean(item.dialogFolder);
      const rows = item.bots.map(bot=>'<tr><td>'+escapeHtml(bot.name)+'</td><td>'+(bot.mode === 'command' ? '命令' : '按钮')+'</td><td>'+escapeHtml(bot.mode === 'command' ? bot.command : '—')+'</td><td>'+escapeHtml(bot.note || '—')+'</td><td>'+escapeHtml(bot.schedule?.enabled ? '每日 '+bot.schedule.time+'（北京时间）' : '跟随账号计划')+'</td></tr>').join('');
      const discovered = item.discoveredBots.map(bot=>'<tr><td>'+escapeHtml(bot.bot)+'</td><td>'+escapeHtml(({button:'按钮',command:'命令',unsupported:'无签到方式',unknown:'待确认'})[bot.mode] || bot.mode || '待确认')+'</td><td>'+escapeHtml(bot.command || '—')+'</td></tr>').join('');
      return '<section class="panel audit-bot-card"><div class="panel-head"><div><h3>'+escapeHtml(item.name || item.session)+'</h3><p>Session：'+escapeHtml(item.session)+'</p></div><span class="count-pill">'+item.bots.length+' 个配置 Bot</span></div>'+(folder ? '<div class="notice audit-folder-note">当前使用 Telegram 对话分组 '+escapeHtml(item.dialogFolder)+'；下方手动列表及其独立定时暂不执行。</div>' : '')+'<div class="table-wrap"><table><thead><tr><th>Bot</th><th>签到方式</th><th>命令</th><th>备注</th><th>独立定时</th></tr></thead><tbody>'+ (rows || '<tr><td colspan="5">未配置手动 Bot。</td></tr>') +'</tbody></table></div>'+(folder || discovered ? '<div class="panel-head"><div><h3>对话分组识别记录</h3></div></div><div class="table-wrap"><table><thead><tr><th>Bot</th><th>识别方式</th><th>命令</th></tr></thead><tbody>'+(discovered || '<tr><td colspan="3">尚无 Bot 识别记录，首次运行后生成。</td></tr>')+'</tbody></table></div>' : '')+'</section>';
    }).join('') || '<div class="automation-empty">此用户或当前账号下没有 Bot 配置。</div>';
  }
  userSelect.addEventListener('change',()=>{
    accountSelect.innerHTML = '<option value="">所有账号</option>';
    $('#audit-log-filters').reset();loadSnapshot();
  });
  accountSelect.addEventListener('change',loadSnapshot);
  $('#audit-refresh').addEventListener('click',loadAuditUsers);
  $('#audit-log-filters').addEventListener('submit',event=>{event.preventDefault();render();});
  $('#audit-log-filters').addEventListener('reset',()=>setTimeout(render,0));
  $('#audit-tab-logs').addEventListener('click',()=>switchTab(false));
  $('#audit-tab-bots').addEventListener('click',()=>switchTab(true));
  function switchTab(bots) {
    $('#audit-logs').hidden = bots;$('#audit-bots').hidden = !bots;
    $('#audit-tab-logs').setAttribute('aria-pressed',String(!bots));
    $('#audit-tab-bots').setAttribute('aria-pressed',String(bots));
  }
})();
