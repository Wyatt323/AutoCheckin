let featureEditorOpen = false;
let cleanupEditorOpen = false;
let cleanupRuns = [], cleanupStarting = new Set();
let savedCleanupRules = new Map();
const cleanupSignature = rule => JSON.stringify([rule.name || '',rule.account || '',rule.group || '']);
function rememberSavedCleanupSettings() {
  savedCleanupRules = new Map(cleanupRules().map(rule=>[rule.id,cleanupSignature(rule)]));
}
let featureLookupTimer = null, featureLookupRunning = false;
const featureRules = () => config?.automations?.forwardPins || [];
const featureRule = id => featureRules().find(rule => rule.id === id);
const featureVisible = () => !document.hidden && currentView === 'features' && (featureEditorOpen || cleanupEditorOpen);
const cleanupRules = () => config?.plugins?.zeroSpeakers || [];
const cleanupRule = id => cleanupRules().find(rule=>rule.id===id);
function peerRule(input) {
  const card = input.closest('[data-feature-rule],[data-cleanup-rule]');
  return card?.hasAttribute('data-cleanup-rule') ? cleanupRule(card.dataset.cleanupRule) : featureRule(card?.dataset.featureRule);
}

function readFeatureEditors() {
  if (!config) return;
  document.querySelectorAll('[data-feature-rule]').forEach(card => {
    const rule = featureRule(card.dataset.featureRule);
    if (!rule) return;
    card.querySelectorAll('[data-feature-field]').forEach(input => { rule[input.dataset.featureField] = input.type === 'checkbox' ? input.checked : input.value; });
    rule.sources = [...card.querySelectorAll('[data-feature-source]')].map(input => input.value.trim());
    rule.keywords = [...card.querySelectorAll('[data-feature-keyword]')].map(input => input.value.trim()).filter(Boolean);
  });
  document.querySelectorAll('[data-cleanup-rule]').forEach(card=>{
    const rule=cleanupRule(card.dataset.cleanupRule);
    if(rule)card.querySelectorAll('[data-cleanup-field]').forEach(input=>{rule[input.dataset.cleanupField]=input.value.trim();});
  });
}

function featurePeerInput(value, label, attribute) {
  return `<span class="peer-input-row"><input ${attribute} data-feature-peer value="${escapeHtml(value || '')}" aria-label="${label}" placeholder="ID、@用户名 或 t.me 链接" maxlength="120"><span class="peer-name" data-feature-peer-name hidden role="status" aria-live="polite"></span></span>`;
}

function renderFeatureCenter() {
  if (!config) return;
  config.automations.forwardPins ||= [];
  config.plugins ||= {};config.plugins.zeroSpeakers ||= [];
  $('#feature-catalog').hidden = featureEditorOpen || cleanupEditorOpen;
  $('#forward-pin-editor').hidden = !featureEditorOpen;
  const rules = featureRules(), enabled = rules.filter(rule => rule.enabled !== false).length;
  $('#forward-pin-count').textContent = rules.length ? `${rules.length} 条规则 · ${enabled} 条启用` : '尚无规则';
  $('#add-forward-pin').disabled = !config.users.length;
  renderCleanupCenter();
  $('#forward-pin-rules').innerHTML = rules.length ? rules.map((rule, index) => `
    <article class="automation-card feature-rule" data-feature-rule="${escapeHtml(rule.id)}">
      <div class="automation-card-head"><div class="automation-card-symbol">↗</div><div><strong>${escapeHtml(rule.name || `规则 ${index + 1}`)}</strong><small>${(rule.sources || []).length} 个监听来源 · ${rule.keywords?.length ? `${rule.keywords.length} 个关键词` : '全部新消息'}</small></div><div class="automation-card-actions"><label class="auto-switch"><input type="checkbox" data-feature-field="enabled" ${rule.enabled !== false ? 'checked' : ''}><i></i>启用规则</label><button class="delete-btn" type="button" data-feature-remove>删除规则</button></div></div>
      <div class="auto-field-grid">
        <label class="auto-field"><span>规则名称</span><input data-feature-field="name" value="${escapeHtml(rule.name || '')}" maxlength="80" placeholder="例如 重要通知同步"></label>
        <label class="auto-field"><span>执行 TG 账号</span><select data-feature-field="account" aria-label="执行 TG 账号"><option value="">选择账号</option>${config.users.map(user => `<option value="${escapeHtml(user.session)}" ${user.session === rule.account ? 'selected' : ''}>${escapeHtml(user.name)} (${escapeHtml(user.session)})${user.sessionReady ? '' : ' · 待登录'}</option>`).join('')}</select></label>
        <div class="auto-field wide"><div class="feature-field-heading"><span>监听来源</span><button class="outline-btn" type="button" data-feature-add-source>＋ 添加来源</button></div><div class="feature-input-list">${(rule.sources || ['']).map((source, i) => `<div class="feature-input-item">${featurePeerInput(source, `监听来源 ${i + 1}`, 'data-feature-source')}<button class="feature-remove-item" type="button" data-feature-remove-source="${i}" aria-label="移除来源 ${i + 1}">×</button></div>`).join('')}</div><small>每条规则支持 1–20 个群组或频道；多个来源使用同一执行账号。</small></div>
        <label class="auto-field wide"><span>转发目标</span>${featurePeerInput(rule.target, '转发目标', 'data-feature-field="target"')}</label>
        <div class="auto-field wide"><div class="feature-field-heading"><span>关键词 · 可选</span><button class="outline-btn" type="button" data-feature-add-keyword>＋ 添加关键词</button></div><div class="feature-input-list feature-keywords">${(rule.keywords || []).map((keyword, i) => `<div class="feature-input-item"><input data-feature-keyword value="${escapeHtml(keyword)}" aria-label="关键词 ${i + 1}" maxlength="100" placeholder="填写要匹配的文字"><button class="feature-remove-item" type="button" data-feature-remove-keyword="${i}" aria-label="移除关键词 ${i + 1}">×</button></div>`).join('') || '<p class="feature-all-messages">未添加关键词 · 转发全部新消息</p>'}</div><small>命中任意关键词即可转发，最多 50 个；按文字包含匹配，不使用正则表达式。</small></div>
        <label class="auto-switch feature-pin-switch"><input type="checkbox" data-feature-field="pinAfterForward" ${rule.pinAfterForward ? 'checked' : ''}><i></i><span>转发后置顶<small>置顶转发到目标的消息，不发送置顶通知。</small></span></label>
      </div>
    </article>`).join('') : `<div class="automation-empty">${config.users.length ? '还没有规则。点击“添加规则”配置你的监听来源。' : '请先在账号管理中添加并登录 Telegram 账号，再配置插件。'}</div>`;
  renderFeatureStatus();
  scheduleFeatureLookup();
}

function renderFeatureStatus() {
  const element = $('#feature-runtime-status');
  if (!element) return;
  const names = {idle:'未启动',starting:'准备监听',running:'运行中',paused:'已暂停',stopping:'正在停止',failed:'运行异常',unavailable:'无法启动'};
  element.textContent = `自动化：${names[automationState?.status] || '读取中'}${automationState?.message ? ' · '+automationState.message : ''}`;
}

function paintFeaturePeerNames() {
  $$('[data-feature-rule] [data-feature-peer], [data-cleanup-rule] [data-feature-peer]').forEach(input => {
    const rule = peerRule(input), value = input.value.trim();
    const badge = input.parentElement.querySelector('[data-feature-peer-name]');
    const entry = peerNames.get(peerKey(rule?.account, value));
    const user = config.users.find(user => user.session === rule?.account);
    const waiting = !rule?.account ? '请先选择执行账号' : !user?.sessionReady ? '请先登录此账号' : runBusy(rule.account) ? '任务结束后自动查询' : '等待查询…';
    badge.hidden = !value;
    badge.className = `peer-name ${entry?.status === 'ok' ? 'resolved' : entry?.status === 'error' ? 'unavailable' : 'loading'}`;
    badge.textContent = entry?.status === 'ok' ? entry.title : entry?.message || waiting;
    badge.title = entry?.status === 'ok' ? `${entry.title} · ID ${entry.id}` : '使用规则的执行账号查询';
  });
}

function scheduleFeatureLookup(delay = 250) {
  clearTimeout(featureLookupTimer);
  if (!featureVisible()) return;
  paintFeaturePeerNames();
  featureLookupTimer = setTimeout(resolveFeaturePeers, delay);
}

async function resolveFeaturePeers() {
  if (featureLookupRunning || !featureVisible()) return;
  let account;
  let blockedByTask = false;
  const peers = [];
  for (const input of $$('[data-feature-rule] [data-feature-peer], [data-cleanup-rule] [data-feature-peer]')) {
    if (input.closest('[hidden]')) continue;
    const rule = peerRule(input), value = input.value.trim();
    if (!value || !rule?.account || !config.users.some(user => user.session === rule.account && user.sessionReady)) continue;
    if (runBusy(rule.account)) {blockedByTask=true;continue;}
    const cached = peerNames.get(peerKey(rule.account, value));
    if (cached?.expires > Date.now()) continue;
    account ||= rule.account;
    if (rule.account === account && !peers.includes(value)) peers.push(value);
    if (peers.length === 4) break;
  }
  if (!peers.length) {
    if(blockedByTask)featureLookupTimer=setTimeout(resolveFeaturePeers,2000);
    return;
  }
  featureLookupRunning = true;
  for (const value of peers) peerNames.set(peerKey(account,value),{status:'loading',message:'查询中…',expires:0});
  paintFeaturePeerNames();
  try {
    const data = await api('/api/accounts/chats/resolve',{method:'POST',body:JSON.stringify({account,peers})});
    for (const value of peers) {
      const result = data.results?.find(item => item.value === value);
      peerNames.set(peerKey(account,value),{...(result || {status:'error',message:'暂时无法获取名称'}),expires:Date.now()+(result?.status === 'ok' ? 600000 : 30000)});
    }
  } catch (error) {
    for (const value of peers) peerNames.set(peerKey(account,value),{status:'error',message:error.message,expires:Date.now()+10000});
  } finally {
    featureLookupRunning = false;
    while (peerNames.size > 400) peerNames.delete(peerNames.keys().next().value);
    paintFeaturePeerNames();scheduleFeatureLookup();
  }
}

$('#open-forward-pin').addEventListener('click',() => {readEditors();featureEditorOpen=true;cleanupEditorOpen=false;renderFeatureCenter();});
$('#close-forward-pin').addEventListener('click',() => {readEditors();featureEditorOpen=false;renderFeatureCenter();});
$('#add-forward-pin').addEventListener('click',() => {
  readEditors();
  if (!config.users.length) {toast('先添加 Telegram 账号',true);return;}
  config.automations.forwardPins.push({id:crypto.randomUUID(),enabled:true,name:'',account:(config.users.find(user => user.sessionReady) || config.users[0]).session,sources:[''],target:'',keywords:[],pinAfterForward:false});
  renderFeatureCenter();$('#forward-pin-rules [data-feature-rule]:last-child [data-feature-field="name"]')?.focus();
});
$('#feature-forward-logs').addEventListener('click',() => {
  navigate('activity');$('#log-filter-category').value='forward';$('#log-filter-category').dispatchEvent(new Event('change',{bubbles:true}));
});
$('#forward-pin-rules').addEventListener('click',async event => {
  const card = event.target.closest('[data-feature-rule]');
  if (!card) return;
  // Preserve empty keyword slots before reading the other editors.
  const keywords = [...card.querySelectorAll('[data-feature-keyword]')].map(input => input.value.trim());
  readEditors();
  const rule = featureRule(card.dataset.featureRule);
  if (!rule) return;
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-feature-remove')) {
    if (!await UIControls.confirm({title:'删除插件规则',message:'删除后需保存才会停止此规则。',confirmText:'删除规则'})) return;
    config.automations.forwardPins=featureRules().filter(item => item.id !== rule.id);
  } else if (button.hasAttribute('data-feature-add-source')) {
    if (rule.sources.length >= 20) {toast('每条规则最多 20 个来源',true);return;} rule.sources.push('');
  } else if (button.hasAttribute('data-feature-remove-source')) {
    rule.sources.splice(Number(button.dataset.featureRemoveSource),1);if (!rule.sources.length) rule.sources.push('');
  } else if (button.hasAttribute('data-feature-add-keyword')) {
    if (keywords.length >= 50) {toast('每条规则最多 50 个关键词',true);return;} rule.keywords=[...keywords,''];
  } else if (button.hasAttribute('data-feature-remove-keyword')) {
    keywords.splice(Number(button.dataset.featureRemoveKeyword),1);rule.keywords=keywords;
  } else return;
  renderFeatureCenter();
});
function onFeaturePeerInput(event) {
  if (event.target.matches('[data-feature-peer]')) scheduleFeatureLookup(event.type === 'input' ? 250 : 0);
}
$('#forward-pin-rules').addEventListener('input',onFeaturePeerInput);
$('#forward-pin-rules').addEventListener('paste',onFeaturePeerInput);
$('#forward-pin-rules').addEventListener('focusout',onFeaturePeerInput);
$('#forward-pin-rules').addEventListener('change',() => {readFeatureEditors();scheduleFeatureLookup(0);});
document.addEventListener('visibilitychange',() => scheduleFeatureLookup(0));
window.addEventListener('pagehide',() => clearTimeout(featureLookupTimer),{once:true});

function cleanupAccountSelect(rule) {
  return `<select data-cleanup-field="account" aria-label="执行 TG 账号"><option value="">选择账号</option>${config.users.map(user=>`<option value="${escapeHtml(user.session)}" ${user.session===rule.account ? 'selected' : ''}>${escapeHtml(user.name)} (${escapeHtml(user.session)})${user.sessionReady ? '' : ' · 待登录'}</option>`).join('')}</select>`;
}
function renderCleanupCenter() {
  $('#zero-speakers-editor').hidden=!cleanupEditorOpen;
  $('#zero-speakers-count').textContent=cleanupRules().length ? `${cleanupRules().length} 条规则 · 手动启动` : '尚无规则';
  $('#add-zero-speakers').disabled=!config.users.length;
  $('#zero-speakers-rules').innerHTML=cleanupRules().map((rule,index)=>`<article class="automation-card feature-rule" data-cleanup-rule="${escapeHtml(rule.id)}"><div class="automation-card-head"><div class="automation-card-symbol">♧</div><div><strong>${escapeHtml(rule.name || `清理规则 ${index+1}`)}</strong><small>检测 → Excel 报告 → 群内确认 → 清理</small></div><div class="automation-card-actions"><button class="delete-btn" type="button" data-cleanup-remove>删除规则</button></div></div><div class="auto-field-grid"><label class="auto-field"><span>规则名称</span><input data-cleanup-field="name" value="${escapeHtml(rule.name || '')}" maxlength="80" placeholder="例如 交流群成员清理"></label><label class="auto-field"><span>执行 TG 账号</span>${cleanupAccountSelect(rule)}</label><label class="auto-field wide"><span>目标群组</span>${featurePeerInput(rule.group,'目标群组','data-cleanup-field="group"')}<small>支持普通群组和超级群组。请使用有移除成员权限的管理员账号。</small></label></div><div class="cleanup-rule-runtime" data-cleanup-runtime></div><div class="cleanup-rule-actions"><button class="primary-btn" type="button" data-cleanup-run>启动检测</button><button class="outline-btn" type="button" data-cleanup-log hidden>运行日志</button><button class="outline-btn" type="button" data-cleanup-stop hidden>停止任务</button><a class="outline-btn" data-cleanup-report hidden>下载 Excel</a></div></article>`).join('') || `<div class="automation-empty">${config.users.length ? '点击“添加规则”，选择账号与需要检测的群组。' : '请先添加并登录 Telegram 账号。'}</div>`;
  renderCleanupStatus();
}
function renderCleanupStatus(runs = cleanupRuns) {
  cleanupRuns=runs;
  const phases={preparing:'准备检测',scanning:'正在检测历史发言',reporting:'生成并发送 Excel',awaiting_confirmation:'等待执行账号在群内发送“是”或“否”',kicking:'正在清理并解除个人限制',completed:'检测/清理已完成',partial:'部分清理完成',cancelled:'已取消',failed:'运行失败'};
  $$('[data-cleanup-rule]').forEach(card=>{
    const rule=cleanupRule(card.dataset.cleanupRule), run=cleanupRuns.filter(run=>run.ruleId===rule?.id).at(-1);
    const active=run && ['running','stopping'].includes(run.state), progress=run?.featureProgress || {};
    if(card.dataset.cleanupActive==='yes' && !active)scheduleFeatureLookup();
    card.dataset.cleanupActive=active ? 'yes' : 'no';
    card.querySelectorAll('[data-cleanup-field]').forEach(input=>{input.disabled=Boolean(active);});
    const label=run ? (active ? phases[progress.phase] || '运行中' : statusText[run.state] || run.state) : '尚未运行';
    const counts=progress.total!==undefined ? `群成员 ${progress.total} 人 · 0发言 ${progress.zeroCount ?? '检测中'} 人${progress.eligibleCount!==undefined ? ' · 可清理 '+progress.eligibleCount+' 人' : ''}` : progress.scanned ? `已扫描 ${progress.scanned} 条历史消息` : '启动检测后，会先向群内发送检测提示。';
    card.querySelector('[data-cleanup-runtime]').innerHTML=`<strong>${escapeHtml(label)}</strong><small>${escapeHtml(counts)}${run ? ' · '+escapeHtml(formatDate(run.startedAt)) : ''}</small>${progress.removed ? `<small>已移出 ${Number(progress.removed)} 人 · 跳过 ${Number(progress.skipped || 0)} 人 · 失败 ${Number(progress.failed || 0)} 人</small>` : ''}`;
    card.querySelector('[data-cleanup-run]').disabled=active || cleanupStarting.has(rule?.id) || runBusy(rule?.account) || savingConfig || !config.users.some(user=>user.session===rule?.account && user.sessionReady);
    const log=card.querySelector('[data-cleanup-log]');log.hidden=!run;log.dataset.runId=run?.id || '';
    const stop=card.querySelector('[data-cleanup-stop]');stop.hidden=!active;stop.disabled=run?.state==='stopping';stop.dataset.runId=run?.id || '';
    card.querySelector('[data-cleanup-remove]').disabled=active;
    const report=card.querySelector('[data-cleanup-report]');report.hidden=!progress.reportReady;report.href=run ? '/api/features/zero-speakers/report?id='+encodeURIComponent(run.id) : '#';
  });
}
$('#open-zero-speakers').addEventListener('click',()=>{readEditors();featureEditorOpen=false;cleanupEditorOpen=true;renderFeatureCenter();});
$('#close-zero-speakers').addEventListener('click',()=>{readEditors();cleanupEditorOpen=false;renderFeatureCenter();});
$('#add-zero-speakers').addEventListener('click',()=>{
  readEditors();if(!config.users.length){toast('先添加 Telegram 账号',true);return;}
  config.plugins.zeroSpeakers.push({id:crypto.randomUUID(),name:'',account:(config.users.find(user=>user.sessionReady) || config.users[0]).session,group:''});
  renderFeatureCenter();$('#zero-speakers-rules [data-cleanup-rule]:last-child input')?.focus();
});
$('#zero-speakers-rules').addEventListener('input',onFeaturePeerInput);
$('#zero-speakers-rules').addEventListener('paste',onFeaturePeerInput);
$('#zero-speakers-rules').addEventListener('focusout',onFeaturePeerInput);
$('#zero-speakers-rules').addEventListener('change',()=>{readFeatureEditors();scheduleFeatureLookup(0);renderCleanupStatus();});
$('#zero-speakers-rules').addEventListener('click',async event=>{
  const button=event.target.closest('button'),card=event.target.closest('[data-cleanup-rule]');if(!button || !card)return;
  const id=card.dataset.cleanupRule;
  try {
    if(button.hasAttribute('data-cleanup-remove')) {
      if(!await UIControls.confirm({title:'删除清理规则',message:'删除配置后需保存。已生成的报告和运行记录仍会保留。',confirmText:'删除规则'}))return;
      readEditors();config.plugins.zeroSpeakers=cleanupRules().filter(rule=>rule.id!==id);renderFeatureCenter();
    }else if(button.hasAttribute('data-cleanup-run')) {
      cleanupStarting.add(id);renderCleanupStatus();
      readEditors();
      if(runBusy()) {
        if(savedCleanupRules.get(id)!==cleanupSignature(cleanupRule(id)))throw Error('当前有其他任务运行，请先等待结束并保存此规则；已保存且未修改的规则可以并行启动。');
      }else if(!await saveConfig())return;
      const data=await api('/api/features/zero-speakers/run',{method:'POST',body:JSON.stringify({ruleId:id})});
      cleanupRuns.push(data.run);renderCleanupStatus();await poll();toast('检测已启动，请在目标群查看报告并确认');
    }else if(button.hasAttribute('data-cleanup-log')) {
      const run=cleanupRuns.find(run=>run.id===button.dataset.runId);if(run)openRunLog(run);
    }else if(button.hasAttribute('data-cleanup-stop')) {
      if(!await UIControls.confirm({title:'停止清理任务',message:'确定停止本次任务？已经移出的成员不会重新加入，后续成员将停止处理。',confirmText:'停止任务'}))return;
      await api('/api/features/zero-speakers/stop',{method:'POST',body:JSON.stringify({id:button.dataset.runId})});await poll();
    }
  }catch(error){toast(error.message,true);}finally{cleanupStarting.delete(id);renderCleanupStatus();}
});
if(config)rememberSavedCleanupSettings();
