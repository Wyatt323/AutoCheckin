(() => {
  let state={rules:[],accounts:[],events:[]},drafts=[],loaded=false,loading=false,acting=false;
  const expanded=new Set(),logsOpen=new Set(),saved=new Map();
  const labels={none:'尚未申诉',running:'申诉处理中',not_needed:'无需申诉',pending:'等待官方审核',submitted:'官方已受理',manual:'需要本人处理',sent_unconfirmed:'已发送，待核实',unconfirmed:'结果待核实',error:'操作未完成'};
  const signature=rule=>JSON.stringify([rule.name,rule.account,rule.appealText]);
  const when=value=>value ? formatDate(typeof value==='number' ? new Date(value).toISOString() : value) : '—';
  const accountFor=rule=>state.accounts.find(account=>account.account===rule.account);
  window.readSpamEditors=()=>$$('[data-spam-rule]').forEach(card=>{
    const rule=drafts.find(rule=>rule.id===card.dataset.spamRule);if(!rule)return;
    card.querySelectorAll('[data-spam-field]').forEach(input=>rule[input.dataset.spamField]=input.value);
  });
  function accept(response,replace=false) {
    state=response.spam;
    if(replace || !loaded){drafts=structuredClone(state.rules);saved.clear();for(const rule of state.rules)saved.set(rule.id,signature(rule));loaded=true;}
    receiveAccountSecuritySummary(state.accounts);
  }
  async function load(replace=false) {
    if(loading)return;loading=true;
    try{accept(await api('/api/features/spam'),replace);$('#spam-plugin-error').hidden=true;if(replace)renderSpamCenter();else renderRuntime();}
    catch(error){$('#spam-plugin-error').textContent=error.message;$('#spam-plugin-error').hidden=false;}
    finally{loading=false;}
  }
  function renderRuntime() {
    $('#add-spam-rule').disabled=!loaded || !config?.users.length || acting;
    $('#spam-plugin-count').textContent=state.rules.length ? `${state.rules.length} 个账号已配置` : '尚无规则';
    $$('[data-spam-rule]').forEach(card=>{
      const rule=drafts.find(rule=>rule.id===card.dataset.spamRule);if(!rule)return;
      const account=accountFor(rule),spam=account?.spam,busy=account?.checking || acting;
      card.querySelector('[data-spam-runtime]').innerHTML=`<strong>${escapeHtml(spamStatusLabel(spam))}${account?.checking ? ' · 正在处理' : ''}</strong><small class="security-secondary">${escapeHtml(spam?.detail || '尚未查询')} · 最近查询：${escapeHtml(when(spam?.checkedAt))}</small><small class="security-secondary">申诉：${escapeHtml(labels[spam?.appealState] || '尚未申诉')}${spam?.nextAppealAt>Date.now() ? ' · 下次可尝试：'+escapeHtml(when(spam.nextAppealAt)) : ''}</small>`;
      const dirty=saved.get(rule.id)!==signature(rule);
      card.querySelector('[data-spam-save-state]').textContent=dirty ? '有未保存的配置' : '配置已保存';
      card.querySelector('[data-spam-save]').disabled=busy;
      card.querySelector('[data-spam-check]').disabled=busy || dirty || !account?.sessionReady || spam?.nextCheckAt>Date.now();
      card.querySelector('[data-spam-submit]').disabled=busy || dirty || !account?.sessionReady || spam?.nextCheckAt>Date.now() || spam?.nextAppealAt>Date.now();
      card.querySelector('[data-spam-remove]').disabled=busy;
      const events=state.events.filter(event=>event.account===rule.account);
      card.querySelector('[data-spam-log-content]').textContent=events.length ? events.map(event=>when(event.time)+'\n'+event.detail).join('\n\n') : '此账号尚无 SpamBot 运行记录。';
      const reply=card.querySelector('[data-spam-reply]');reply.hidden=!spam?.reply;reply.querySelector('pre').textContent=spam?.reply || '';
    });
  }
  window.renderSpamCenter=()=>{
    $('#spam-plugin-editor').hidden=!spamEditorOpen;
    if(!spamEditorOpen)return;
    $('#view-features').setAttribute('aria-labelledby','spam-plugin-title');
    $('#add-spam-rule').disabled=!loaded || !config?.users.length || acting;
    $('#spam-rules').innerHTML=drafts.map((rule,index)=>`<article class="automation-card feature-rule spam-rule" data-spam-rule="${escapeHtml(rule.id)}" data-expanded="${expanded.has(rule.id)}"><div class="automation-card-head"><button type="button" class="rule-card-toggle" data-spam-toggle aria-expanded="${expanded.has(rule.id)}" aria-controls="spam-body-${rule.id}"><span class="automation-card-symbol">${lineIcon('shield')}</span><span class="rule-card-heading"><strong>${escapeHtml(rule.name || 'Spam 规则 '+(index+1))}</strong><small>${escapeHtml(config.users.find(user=>user.session===rule.account)?.name || '请选择账号')} · 官方 @SpamBot 误封申诉</small></span><span class="rule-toggle-affordance" data-spam-toggle-label>${expanded.has(rule.id) ? '收起配置 ↑' : '展开配置 ↓'}</span></button><div class="automation-card-actions"><button class="delete-btn" type="button" data-spam-remove>删除规则</button></div></div><div class="spam-rule-body" id="spam-body-${rule.id}" ${expanded.has(rule.id) ? '' : 'inert'} aria-hidden="${!expanded.has(rule.id)}"><div class="spam-rule-content"><div class="auto-field-grid spam-rule-fields"><label class="auto-field"><span>规则名称</span><input data-spam-field="name" value="${escapeHtml(rule.name)}" maxlength="80"></label><label class="auto-field"><span>执行 TG 账号</span><select data-spam-field="account" aria-label="Spam 执行账号"><option value="">选择账号</option>${config.users.map(user=>`<option value="${escapeHtml(user.session)}" ${user.session===rule.account ? 'selected' : ''}>${escapeHtml(user.name)} (${escapeHtml(user.session)})</option>`).join('')}</select></label><label class="auto-field wide"><span>误封申诉内容</span><textarea data-spam-field="appealText" minlength="10" maxlength="2000" rows="6" placeholder="请根据真实情况说明为何认为限制有误，不要填写密码或验证码。">${escapeHtml(rule.appealText)}</textarea><small>10–2000 字，提交前需确认。模板请按实际情况修改。</small></label></div></div></div><div class="spam-rule-runtime" data-spam-runtime role="status"></div><div class="rule-card-footer"><small data-spam-save-state></small><div class="rule-card-buttons"><button class="outline-btn" type="button" data-spam-logs>规则日志</button><button class="outline-btn" type="button" data-spam-check>查询状态</button><button class="primary-btn" type="button" data-spam-save>保存规则</button><button class="primary-btn" type="button" data-spam-submit>提交误封申诉</button></div></div><div class="spam-rule-logs" data-spam-log-panel ${logsOpen.has(rule.id) ? '' : 'hidden'}><strong>此账号的 SpamBot 记录</strong><pre data-spam-log-content></pre><details data-spam-reply hidden><summary>SpamBot 最近原始回复</summary><pre></pre></details></div></article>`).join('') || '<div class="automation-empty">添加规则，选择已登录的账号并填写真实申诉内容。</div>';
    renderRuntime();window.UIControls?.refresh();
  };
  window.openSpamFeature=async()=>{
    readEditors();checkinEditorOpen=featureEditorOpen=cleanupEditorOpen=redPacketEditorOpen=false;spamEditorOpen=true;navigate('features');
    if(!loaded)await load(true);else renderSpamCenter();
  };
  $('#open-spam').addEventListener('click',openSpamFeature);
  $('#close-spam').addEventListener('click',()=>{readSpamEditors();spamEditorOpen=false;renderFeatureCenter();});
  $('#add-spam-rule').addEventListener('click',()=>{
    readSpamEditors();const user=config.users.find(user=>!drafts.some(rule=>rule.account===user.session));
    if(!user){toast('每个账号只需一条 Spam 规则，请编辑已有规则',true);return;}
    const rule={id:crypto.randomUUID(),name:'Spam 申诉',account:user.session,appealText:'Hello Telegram team, I believe my account was limited by mistake. Please review the restriction. I am willing to provide any further information needed. Thank you.'};
    drafts.push(rule);expanded.add(rule.id);renderSpamCenter();
  });
  $('#spam-rules').addEventListener('input',()=>{readSpamEditors();renderRuntime();});
  $('#spam-rules').addEventListener('change',()=>{readSpamEditors();renderRuntime();});
  $('#spam-rules').addEventListener('click',async event=>{
    const button=event.target.closest('button'),card=event.target.closest('[data-spam-rule]');if(!button || !card || acting)return;
    const id=card.dataset.spamRule;readSpamEditors();const rule=drafts.find(rule=>rule.id===id);
    if(button.hasAttribute('data-spam-toggle')){const open=!expanded.has(id);if(open)expanded.add(id);else expanded.delete(id);card.dataset.expanded=String(open);button.setAttribute('aria-expanded',String(open));card.querySelector('.spam-rule-body').inert=!open;card.querySelector('.spam-rule-body').setAttribute('aria-hidden',String(!open));card.querySelector('[data-spam-toggle-label]').textContent=open ? '收起配置 ↑' : '展开配置 ↓';return;}
    if(button.hasAttribute('data-spam-logs')){if(logsOpen.has(id))logsOpen.delete(id);else logsOpen.add(id);card.querySelector('[data-spam-log-panel]').hidden=!logsOpen.has(id);return;}
    let mode;
    if(button.hasAttribute('data-spam-submit')){
      mode='appeal';
      if(!await UIControls.confirm({title:'确认提交误封申诉',message:`账号：${accountFor(rule)?.name || rule.account}\n\n申诉内容：\n${rule.appealText}\n\n点击提交即确认：这是误封，我未向陌生人发送 SpamBot 所列的垃圾广告或违规内容，并承诺不这样做。程序可代选官方申诉步骤；验证码和其他提问需要本人处理。Telegram 审核决定是否解除限制。`,confirmText:'确认声明并提交'}))return;
    }else if(button.hasAttribute('data-spam-check'))mode='check';
    else if(button.hasAttribute('data-spam-remove') && !await UIControls.confirm({title:'删除 Spam 规则',message:'删除此规则？账号已提交的申诉及历史查询结果会保留。',confirmText:'删除规则'}))return;
    acting=true;renderRuntime();
    try{
      if(button.hasAttribute('data-spam-save')){const response=await api('/api/features/spam',{method:'PUT',body:JSON.stringify(rule)});accept(response);saved.set(id,signature(rule));expanded.delete(id);renderSpamCenter();toast('Spam 规则已保存');}
      else if(button.hasAttribute('data-spam-remove')){if(saved.has(id))accept(await api('/api/features/spam?ruleId='+encodeURIComponent(id),{method:'DELETE'}));drafts=drafts.filter(rule=>rule.id!==id);saved.delete(id);renderSpamCenter();}
      else if(mode){accept(await api('/api/features/spam/run',{method:'POST',body:JSON.stringify({ruleId:id,mode,confirm:mode==='appeal',pledge:mode==='appeal'})}));logsOpen.add(id);renderSpamCenter();toast(mode==='appeal' ? '申诉流程已开始，可在规则日志查看进度' : '正在查询 SpamBot 状态');}
    }catch(error){toast(error.message,true);}
    finally{acting=false;renderRuntime();}
  });
  const timer=setInterval(()=>{if(currentView==='features' && spamEditorOpen && !document.hidden && !acting)load();},2500);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
