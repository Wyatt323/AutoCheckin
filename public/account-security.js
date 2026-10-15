(() => {
  let state=null,loading=false,initialized=null,acting=false;
  const keys=['enabled','alertsEnabled','spamCheckEnabled','intervalMinutes','alertCooldownMinutes'];
  const labels={unchecked:'尚未检查',reachable:'信息读取正常',restricted:'平台限制标记',banned:'账号被封禁',deactivated:'账号已停用',login_required:'需要登录',rate_limited:'限流冷却中',unavailable:'检查未完成',action_blocked:'操作受限'};
  const kinds={inspection:'账号检查',device_found:'发现设备',device_trusted:'确认设备',device_terminated:'下线设备',action_failed:'操作未完成',alert:'安全提醒',deferred:'检查延后',identity_changed:'账号身份变化',spam_started:'SpamBot 开始',spam_step:'SpamBot 交互',spam_check:'双向查询',spam_appeal:'误封申诉',spam_interrupted:'操作中断',spam_deferred:'操作延后'};
  const paint=(selector,html)=>{const element=$(selector);if(element.innerHTML!==html)element.innerHTML=html;};
  const badge=(label,tone='')=>`<span class="security-tag ${tone}">${escapeHtml(label)}</span>`;
  const secondary=value=>`<small class="security-secondary">${escapeHtml(value)}</small>`;
  const empty=message=>`<tr class="table-empty-row"><td colspan="5">${escapeHtml(message)}</td></tr>`;
  const time=value=>value ? formatDate(typeof value==='number' ? new Date(value).toISOString() : value) : '—';
  const unknown=row=>row.devices.filter(device=>!device.trusted).length;
  const account=()=>config?.users[selectedAccountIndex]?.session;
  const visible=()=>currentView==='accounts' && accountSection==='security' && selectedAccountIndex!==null;
  window.spamStatusLabel=spam=>({unchecked:'尚未查询',clear:'未发现双向限制',limited:'双向受限',unknown:'状态未确认'})[spam?.status || 'unchecked'] || '状态未确认';
  let summaries=[];
  window.receiveAccountSecuritySummary=rows=>{summaries=rows;window.renderAccountRestrictionBadges();};
  window.renderAccountRestrictionBadges=()=>$$('[data-restriction-account]').forEach(element=>{const spam=summaries.find(row=>row.account===element.dataset.restrictionAccount)?.spam; element.textContent='双向限制：'+spamStatusLabel(spam);element.dataset.tone=spam?.status || 'unchecked';element.title=spam?.checkedAt ? '最近查询：'+time(spam.checkedAt)+' · '+(spam.detail || '') : '打开账号下方的防护菜单查询';});
  function render() {
    if(!state)return;
    const all=state;state={...all,accounts:all.accounts.filter(row=>row.account===account()),events:all.events.filter(row=>row.account===account())};
    $('#security-total').textContent=state.accounts.length;
    $('#security-attention').textContent=state.accounts.filter(row=>row.issues.length).length;
    $('#security-2fa').textContent=state.accounts.filter(row=>row.twoFactor===true).length;
    $('#security-untrusted').textContent=state.accounts.reduce((sum,row)=>sum+unknown(row),0);
    $('#security-checking').textContent=state.checking ? '正在检查…' : (state.accounts[0]?.settings || state.settings).enabled ? '定期巡检已开启' : '定期巡检未开启';
    const selected=state.accounts[0];
    $('#security-check-all').disabled=selected?.checking || acting || !selected || Date.now()<(selected.nextAllowedAt || 0);
    $('#security-spam-check').disabled=!selected?.sessionReady || selected.checking || acting || Date.now()<(selected.spam?.nextCheckAt || 0);
    paint('#security-spam-state',`<strong>${escapeHtml(spamStatusLabel(selected?.spam))}</strong>${secondary(selected?.spam?.detail || '尚未查询')}${secondary('最近查询：'+time(selected?.spam?.checkedAt))}${selected?.spam?.lastKnownStatus && selected.spam.status==='unknown' ? secondary('上次明确结果：'+spamStatusLabel({status:selected.spam.lastKnownStatus})+' · '+time(selected.spam.lastKnownAt)) : ''}${selected?.spam?.reply ? `<details class="security-bot-reply"><summary>查看 SpamBot 原始回复</summary><pre>${escapeHtml(selected.spam.reply)}</pre></details>` : ''}`);
    $('#security-notification-hint').textContent=state.notificationReady ? '使用你在「TG 通知」中保存的个人通知配置。' : '尚未启用 TG 通知，请先到「TG 通知」配置 Bot 和接收会话。';
    paint('#security-accounts',state.accounts.map(row=>{
      const cooldown=Date.now()<(row.nextAllowedAt || 0);
      return `<tr><td data-label="账号"><strong>${escapeHtml(row.name)}</strong>${secondary(row.account)}</td><td data-label="最近检查">${badge(row.checking ? '正在检查' : labels[row.status] || row.status,['banned','deactivated','login_required'].includes(row.status) ? 'bad' : row.issues.length ? 'attention' : '')}${secondary(row.detail)}${secondary('检查时间：'+time(row.lastAttemptAt))}${row.deferred ? secondary('上次延后：'+row.deferred) : ''}</td><td data-label="两步验证">${badge(row.twoFactor===null ? '尚未获取' : row.twoFactor ? '已开启' : '未开启',row.twoFactor===true ? 'good' : row.twoFactor===false ? 'attention' : '')}</td><td data-label="待确认设备">${unknown(row)} 台${secondary('共 '+row.devices.length+' 台登录设备')}</td><td class="record-actions-cell" data-label="操作"><div class="security-device-actions"><button class="outline-btn" type="button" data-security-check="${escapeHtml(row.account)}" ${row.checking || cooldown || acting ? 'disabled' : ''}>检查账号</button><button class="outline-btn" type="button" data-security-view="${escapeHtml(row.account)}">查看设备</button></div>${cooldown ? secondary('下次可检查：'+time(row.nextAllowedAt)) : ''}</td></tr>`;
    }).join('') || empty('请先在账号管理中添加 Telegram 账号。'));
    const choice=$('#security-account'),previous=choice.value;
    const options=state.accounts.map(row=>`<option value="${escapeHtml(row.account)}">${escapeHtml(row.name)} (${escapeHtml(row.account)})</option>`).join('');
    if(choice.dataset.options!==options){choice.innerHTML=options;choice.dataset.options=options;if(state.accounts.some(row=>row.account===previous))choice.value=previous;window.UIControls?.refresh();}
    $('#security-account').value=account() || '';
    renderDevices();
    paint('#security-events',state.events.map(event=>`<tr><td data-label="时间 · 北京时间" class="record-time">${escapeHtml(time(event.time))}</td><td data-label="账号">${escapeHtml(state.accounts.find(row=>row.account===event.account)?.name || event.account)}</td><td data-label="类型">${escapeHtml(kinds[event.kind] || event.kind)}</td><td data-label="说明">${escapeHtml(event.detail)}</td></tr>`).join('') || empty('暂无防护记录。'));
    state=all;
  }
  function renderDevices() {
    const row=state?.accounts.find(row=>row.account===$('#security-account').value);
    if(!row){paint('#security-devices',empty('请先添加账号并执行检查。'));paint('#security-account-detail','');return;}
    const warnings=row.issues.map(value=>`<li>${escapeHtml(value)}</li>`).join('');
    paint('#security-account-detail',`<strong>${escapeHtml(row.name)} · ${escapeHtml(labels[row.status] || row.status)}</strong>${secondary('最近成功读取：'+time(row.lastSuccessAt)+' · TG ID：'+(row.userId || '—'))}${row.twoFactor===false ? secondary('请在 Telegram 官方客户端「设置 → 隐私与安全 → 两步验证」开启密码并设置恢复邮箱。') : row.twoFactor && !row.recoveryEmail ? secondary('两步验证已开启，建议在官方客户端补充恢复邮箱。') : ''}${warnings ? `<ul>${warnings}</ul>` : ''}${row.restrictionReasons.map(value=>secondary(value)).join('')}`);
    paint('#security-devices',row.devices.map(device=>`<tr><td data-label="设备 / 应用"><strong>${escapeHtml(device.device || '未知设备')}</strong>${secondary([device.app,device.version].filter(Boolean).join(' '))}${secondary([device.platform,device.system].filter(Boolean).join(' · '))}</td><td data-label="IP / 地区">${escapeHtml(device.ip || '—')}${secondary([device.country,device.region].filter(Boolean).join(' · ') || '地区未知')}</td><td data-label="登录 / 最近活跃">${secondary('登录：'+time(device.createdAt))}${secondary('活跃：'+time(device.activeAt))}</td><td data-label="确认状态">${badge(device.current ? 'AutoCheckin 当前会话' : device.trusted ? '已确认为本人设备' : '待确认',device.trusted ? 'good' : 'attention')}${device.unconfirmed || device.passwordPending ? secondary('Telegram 标记此登录尚待确认或密码验证') : ''}</td><td class="record-actions-cell" data-label="操作">${device.current ? secondary('当前会话受保护') : `<div class="security-device-actions">${!device.trusted ? `<button class="outline-btn" type="button" data-security-trust="${device.id}" ${acting || row.checking ? 'disabled' : ''}>是我的设备</button>` : ''}<button class="delete-btn" type="button" data-security-terminate="${device.id}" ${acting || row.checking || row.status==='rate_limited' && Date.now()<row.nextAllowedAt ? 'disabled' : ''}>下线设备</button></div>`}</td></tr>`).join('') || empty(row.lastSuccessAt ? '最近一次成功检查未返回登录设备。' : '点击「检查账号」获取设备；尚未检查不表示没有设备。'));
  }
  window.loadAccountSecurity=async()=>{
    if(loading)return;loading=true;
    try {
      const response=await api('/api/account-security');state=response.security;
      if(initialized!==account()){const settings=state.accounts.find(row=>row.account===account())?.settings || state.settings;for(const key of keys){const input=$('#security-'+key);if(input.type==='checkbox')input.checked=settings[key];else input.value=settings[key];}initialized=account();}
      render();$('#security-error').hidden=true;
    }catch(error){$('#security-error').textContent=error.message;$('#security-error').hidden=false;}
    finally{loading=false;}
  };
  async function check(account='') {
    try{const response=await api('/api/account-security/check',{method:'POST',body:JSON.stringify({account})});state=response.security;render();toast('账号检查已开始');}
    catch(error){toast(error.message,true);}
  }
  $('#security-check-all').addEventListener('click',()=>check(account()));
  $('#security-spam-check').addEventListener('click',async()=>{try{await api('/api/features/spam/run',{method:'POST',body:JSON.stringify({account:account(),mode:'check'})});toast('正在向官方 @SpamBot 查询');await loadAccountSecurity();}catch(error){toast(error.message,true);}});
  $('#security-account').addEventListener('change',renderDevices);
  $('#security-settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.target.querySelector('[type="submit"]');button.disabled=true;
    try{const input=Object.fromEntries(keys.map(key=>{const element=$('#security-'+key);return [key,element.type==='checkbox' ? element.checked : Number(element.value)];}));state=(await api('/api/account-security',{method:'PUT',body:JSON.stringify({...input,account:account()})})).security;render();toast('账号防护设置已保存');}
    catch(error){toast(error.message,true);}finally{button.disabled=false;}
  });
  $('#view-security').addEventListener('click',async event=>{
    const button=event.target.closest('[data-security-check],[data-security-view],[data-security-trust],[data-security-terminate]');if(!button || acting)return;
    if(button.hasAttribute('data-security-check')){await check(button.dataset.securityCheck);return;}
    if(button.hasAttribute('data-security-view')){$('#security-account').value=button.dataset.securityView;window.UIControls?.refresh();renderDevices();$('#security-account-detail').scrollIntoView({behavior:'smooth',block:'center'});return;}
    const account=$('#security-account').value,terminate=button.hasAttribute('data-security-terminate'),id=button.dataset.securityTerminate || button.dataset.securityTrust;
    const device=state.accounts.find(row=>row.account===account)?.devices.find(row=>row.id===id);if(!device)return;
    if(!await UIControls.confirm({title:terminate ? '下线登录设备' : '确认本人设备',message:terminate ? `确定下线「${device.device || device.app}」${device.ip ? '（'+device.ip+'）' : ''}？该客户端将需要重新登录 Telegram。` : `请确认「${device.device || device.app}」确实是你使用的设备。`,confirmText:terminate ? '确认下线' : '是我的设备'}))return;
    acting=true;render();
    try{state=(await api('/api/account-security/'+(terminate ? 'terminate' : 'trust'),{method:'POST',body:JSON.stringify({account,deviceId:id,confirm:terminate})})).security;toast(terminate ? '设备已下线' : '设备已确认为本人使用');}
    catch(error){toast(error.message,true);await loadAccountSecurity();}
    finally{acting=false;render();}
  });
  const timer=setInterval(()=>{if(visible() && !document.hidden && !acting)loadAccountSecurity();},3000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && visible())loadAccountSecurity();});
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
