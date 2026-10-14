(() => {
  let loading=false,initialized=false;
  const settingsKeys=['enabled','alertsEnabled','recoveryNotifications','intervalSeconds','failureThreshold','graceSeconds','alertCooldownMinutes','maxRestarts'];
  const labels={online:'连接正常',offline:'连接异常',login_required:'需要登录',unknown:'待检查',stale:'心跳超时',rate_limited:'Telegram 限流',running:'运行中',starting:'正在连接',paused:'正常暂停',stopping:'正在停止',recovering:'自动恢复中',idle:'未启用',failed:'运行异常',unavailable:'无法启动'};
  const badge=(status,text)=>`<span class="status-badge ${['online','running'].includes(status) ? 'status-success' : ['offline','login_required','stale','failed','unavailable'].includes(status) ? 'status-danger' : ['starting','recovering','rate_limited'].includes(status) ? 'status-warning' : 'status-neutral'}">${escapeHtml(text || labels[status] || status)}</span>`;
  const time=value=>value ? escapeHtml(formatDate(value)) : '—';
  const empty=text=>`<tr class="table-empty-row"><td colspan="4">${text}</td></tr>`;
  const title=(row,name)=>escapeHtml(row.owner ? row.owner+' · '+name : name);
  function render(workspaces) {
    const rows=key=>workspaces.flatMap(({user,health})=>health[key].map(item=>({...item,owner:user?.username})));
    const accounts=rows('accounts'),proxies=rows('proxies'),tasks=rows('tasks'),events=rows('events').sort((a,b)=>b.time.localeCompare(a.time)).slice(0,100);
    $('#health-account-count').textContent=accounts.length;
    $('#health-issue-count').textContent=rows('incidents').filter(issue=>issue.confirmed).length;
    $('#health-proxy-count').textContent=proxies.length;
    $('#health-task-count').textContent=tasks.filter(task=>['starting','running','recovering'].includes(task.status)).length;
    $('#health-accounts').innerHTML=accounts.map(row=>`<tr><td data-label="账号"><strong>${title(row,row.name)}</strong><small class="health-secondary">${escapeHtml(row.session)}</small></td><td data-label="连接状态">${badge(row.status,row.status==='online' && !row.active ? '最近检查正常' : null)}</td><td data-label="最近心跳 / 检查" class="record-time">${time(row.checkedAt)}</td><td data-label="说明">${escapeHtml(row.detail)}${row.lastRun ? '<small class="health-secondary">最近签到：'+time(row.lastRun.time)+' · '+escapeHtml(({completed:'已完成',failed:'有未完成项目',stopped:'已停止',running:'运行中'})[row.lastRun.state] || row.lastRun.state)+'</small>' : ''}</td></tr>`).join('') || empty('尚未添加 Telegram 账号。');
    $('#health-proxies').innerHTML=proxies.map(row=>`<tr><td data-label="代理"><strong>${title(row,row.name)}</strong><small class="health-secondary">${escapeHtml(row.type.toUpperCase())}</small></td><td data-label="连通状态">${badge(row.status)}</td><td data-label="延迟 / 检查时间">${row.latencyMs==null ? '—' : escapeHtml(row.latencyMs)+' ms'}<small class="health-secondary">${time(row.checkedAt)}</small></td><td data-label="说明">${escapeHtml(row.detail)}</td></tr>`).join('') || empty('当前没有使用出口代理。');
    $('#health-tasks').innerHTML=tasks.map(row=>`<tr><td data-label="任务"><strong>${title(row,row.name)}</strong></td><td data-label="运行状态">${badge(row.status)}</td><td data-label="最近心跳" class="record-time">${time(row.heartbeatAt)}${row.lastSuccessAt ? '<small class="health-secondary">最近正常执行：'+time(row.lastSuccessAt)+'</small>' : ''}</td><td data-label="说明">${escapeHtml(row.detail || '')}${row.id==='automation' ? `<small class="health-secondary">自动恢复 ${row.retryAttempts}/${row.retryLimit} 次${row.autoRestartBlocked ? ' · 已停止重试' : ''}</small>` : ''}</td></tr>`).join('') || empty('没有正在运行的任务。');
    $('#health-events').innerHTML=events.map(row=>`<tr><td data-label="时间 · 北京时间" class="record-time">${time(row.time)}</td><td data-label="类型">${badge(row.kind==='recovered' ? 'online' : row.kind==='alert' ? 'offline' : 'unknown',({detected:'发现异常',alert:'告警已入队',recovered:'已恢复',closed:'任务已结束 / 已移除'})[row.kind])}</td><td data-label="对象">${title(row,row.name)}</td><td data-label="说明">${escapeHtml(row.detail)}</td></tr>`).join('') || empty('暂无异常与恢复记录。');
    $('#health-restart').hidden=$('#health-scope').value==='all' || !tasks.some(task=>task.id==='automation' && ['failed','unavailable'].includes(task.status));
    const checking=workspaces.some(item=>item.health.checking);
    $('#health-check').disabled=checking || $('#health-scope').value==='all';
    $('#health-check').textContent=checking ? '检查中…' : '立即检查';
    $('#health-summary').textContent=$('#health-scope').value==='all' ? `系统状态 · ${workspaces.length} 个用户 · 已启用监控 ${workspaces.filter(item=>item.health.settings.enabled).length} 个` : `${workspaces[0].health.settings.enabled ? '定期检查已启用' : '定期检查未启用'}${workspaces[0].health.lastCheckAt ? ' · 最近检查 '+formatDate(workspaces[0].health.lastCheckAt) : ''}`;
  }
  window.loadHealth=async()=>{
    if(loading)return;loading=true;
    try {
      $('#health-scope-field').hidden=webUser?.role!=='admin';
      const all=$('#health-scope').value==='all' && webUser?.role==='admin';
      $('#health-settings-panel').hidden=all;
      const response=await api(all ? '/api/admin/health' : '/api/health');
      render(all ? response.workspaces : [{health:response.health}]);
      if(!all) {
        if(!initialized){for(const key of settingsKeys){const input=$('#health-'+key);if(input.type==='checkbox')input.checked=response.health.settings[key];else input.value=response.health.settings[key];}initialized=true;}
        $('#health-notification-hint').textContent=response.health.notificationReady ? 'TG 通知已配置，异常告警使用个人默认出口发送。' : '尚未启用 TG 通知；请先在 TG 通知页面配置 Bot 与接收会话。';
      }
      $('#health-error').hidden=true;
    }catch(error){$('#health-error').hidden=false;$('#health-error').textContent=error.message;}
    finally{loading=false;}
  };
  $('#health-scope').addEventListener('change',loadHealth);
  $('#health-settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.target.querySelector('[type="submit"]');button.disabled=true;
    try {
      const input=Object.fromEntries(settingsKeys.map(key=>{const element=$('#health-'+key);return [key,element.type==='checkbox' ? element.checked : Number(element.value)];}));
      await api('/api/health',{method:'PUT',body:JSON.stringify(input)});toast('健康监控设置已保存');await loadHealth();
    }catch(error){toast(error.message,true);}finally{button.disabled=false;}
  });
  $('#health-check').addEventListener('click',async event=>{
    event.currentTarget.disabled=true;
    try{await api('/api/health/check',{method:'POST',body:'{}'});await loadHealth();}catch(error){toast(error.message,true);event.currentTarget.disabled=false;}
  });
  $('#health-restart').addEventListener('click',async event=>{
    event.currentTarget.disabled=true;
    try{await api('/api/automation/restart',{method:'POST',body:'{}'});toast('正在重新连接自动化');await loadHealth();}catch(error){toast(error.message,true);}finally{event.currentTarget.disabled=false;}
  });
  const timer=setInterval(()=>{if(currentView==='health' && !document.hidden)loadHealth();},3000);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
