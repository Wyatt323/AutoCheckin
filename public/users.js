let webUser = null;
window.renderWebUser = user => {
  webUser = user;
  document.querySelector('#nav-users').hidden = user.role !== 'admin';
  document.querySelector('#nav-audit').hidden = user.role !== 'admin';
  document.querySelector('#nav-global-settings').hidden = false;
  document.querySelector('#nav-admin-global-settings').hidden=user.role!=='admin';
  renderSettingsScope();
  document.querySelector('#web-user-name').textContent = `${user.username} · ${user.role === 'admin' ? '管理员' : '用户'}`;
  document.querySelector('#web-password-link').hidden = user.role !== 'user';
};
async function loadWebUsers() {
  if (webUser?.role !== 'admin') return;
  try {
    const data = await api('/api/users');
    document.querySelector('#admin-username').value = webUser.username;
    document.querySelector('#web-users-list').innerHTML = data.users.length ? data.users.map(user=>`<tr data-web-user-id="${escapeHtml(user.id)}" data-web-username="${escapeHtml(user.username)}"><td data-label="用户名"><strong>${escapeHtml(user.username)}</strong></td><td data-label="密码状态"><span class="status-badge ${user.mustChangePassword ? 'status-warning' : 'status-success'}">${user.mustChangePassword ? '待修改密码' : '已启用'}</span></td><td data-label="创建时间" class="record-time">${escapeHtml(formatDate(user.createdAt))}</td><td class="record-actions-cell"><div class="web-user-actions"><button class="outline-btn" type="button" data-web-user-action="edit">修改</button><button class="outline-btn" type="button" data-web-user-action="reset">重置密码</button><button class="delete-btn" type="button" data-web-user-action="delete">删除</button></div></td></tr>`).join('') : '<tr class="table-empty-row"><td colspan="4">还没有普通用户，点击上方添加。</td></tr>';
  } catch (error) { toast(error.message,true); }
}
document.querySelector('#nav-users').addEventListener('click',loadWebUsers);
document.querySelector('#web-user-create').addEventListener('submit',async event=>{
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const username = document.querySelector('#web-new-username').value.trim();
    await api('/api/users',{method:'POST',body:JSON.stringify({username})});
    event.target.reset();
    await loadWebUsers();
    toast(`已创建 ${username}，初始密码 a123456；首次登录必须修改密码`);
  } catch (error) { toast(error.message,true); }
  finally { button.disabled = false; }
});
const editDialog = document.createElement('dialog');
editDialog.id = 'web-user-edit-dialog';
editDialog.className = 'ui-confirm-dialog';
editDialog.setAttribute('aria-labelledby','web-user-edit-title');
editDialog.innerHTML = '<form id="web-user-edit-form"><h2 id="web-user-edit-title">修改用户</h2><p>修改用户名后，该用户需重新登录；已有任务和数据保持关联。</p><label class="field"><span>用户名</span><input id="web-edit-username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_][A-Za-z0-9_.-]{2,31}" autocomplete="off"></label><p id="web-user-edit-error" role="alert"></p><div class="ui-dialog-actions"><button class="outline-btn" id="web-user-edit-cancel" type="button">取消</button><button class="primary-btn" type="submit">保存修改</button></div></form>';
document.body.append(editDialog);
let editUserId = null;
document.querySelector('#web-user-edit-cancel').addEventListener('click',()=>editDialog.close());
document.querySelector('#web-user-edit-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api(`/api/users/${encodeURIComponent(editUserId)}`,{method:'PATCH',body:JSON.stringify({username:document.querySelector('#web-edit-username').value.trim()})});
    await editDialog.close(); await loadWebUsers(); toast('用户名已修改');
  } catch (error) { document.querySelector('#web-user-edit-error').textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#web-users-list').addEventListener('click',async event=>{
  const button = event.target.closest('[data-web-user-action]');
  if (!button || button.disabled) return;
  const row = button.closest('[data-web-user-id]');
  const id = row.dataset.webUserId, username = row.dataset.webUsername, action = button.dataset.webUserAction;
  if (action === 'edit') {
    editUserId = id; document.querySelector('#web-edit-username').value = username;
    document.querySelector('#web-user-edit-error').textContent = '';
    UIControls.refresh(); editDialog.showModal(); document.querySelector('#web-edit-username').focus(); return;
  }
  button.disabled = true;
  try {
    const accepted = await UIControls.confirm(action === 'reset' ? {title:'重置用户密码',message:`将 ${username} 的密码重置为 a123456，现有登录会话将失效，下次登录必须修改密码。`,confirmText:'重置密码'} : {title:'删除用户',message:`删除 ${username} 后，该用户无法登录，后台任务也将停止。数据保留用于备份；再次添加同名用户会创建全新的工作空间。`,confirmText:'删除用户'});
    if (!accepted) return;
    await api(`/api/users/${encodeURIComponent(id)}${action === 'reset' ? '/reset-password' : ''}`,{method:action === 'reset' ? 'POST' : 'DELETE',body:'{}'});
    await loadWebUsers(); toast(action === 'reset' ? '密码已重置为 a123456，下次登录必须修改密码' : '用户已删除，后台任务已停止');
  } catch (error) { toast(error.message,true); }
  finally { button.disabled = false; }
});
api('/api/auth/status').then(data=>{
  if (data.user) { renderWebUser(data.user); if (location.hash === '#users') loadWebUsers(); }
}).catch(()=>{});

let systemSettings = {telegram:{},providers:[],model:''};
let proxySettings = {proxies:[],defaultProxyId:''};
let editingProxyId=null, editingProviderId=null, globalSaving=false;
let serviceSettingsView=null, serviceLoadVersion=0;
const serviceTests=new Map();
const isProjectSettings=()=>currentView==='admin-global-settings';
const settingsApi=()=>isProjectSettings() ? '/api/admin' : '/api';
function renderSettingsScope() {
  const personal=!isProjectSettings();
  document.querySelector('#global-settings-title').textContent=personal ? '全局设置' : '管理员全局设置';
  document.querySelector('#global-settings-description').textContent=personal ? '管理你自己的账号出口和全局 Telegram API。未设置时自动继承管理员配置，仅对你的账号和任务生效。AI 提供商在 AI 管理中配置。' : '管理整个项目的默认 Telegram API、AI 提供商和出口代理。各用户未设置的项目自动继承这里。';
  document.querySelector('#settings-inheritance').hidden=!personal;
  document.querySelector('#settings-reset-telegram').hidden=!personal;
  document.querySelector('#project-ai-model-field').hidden=personal;
  document.querySelector('#project-ai-providers').hidden=personal;
  document.querySelector('#proxy-default-label').textContent=personal ? '我的账号默认出口' : '项目默认出口';
  document.querySelector('#proxy-default-description').textContent=personal ? '用于你的账号、TG 通知和 AI 测试；账号可再单独选择出口，保存后仅重新连接你的监听任务。' : '用于项目级请求，并作为各用户未配置出口时的默认值。';
  document.querySelector('#global-services-title').textContent=personal ? '我的 Telegram API' : '项目全局服务';
  document.querySelector('#global-services-description').textContent=personal ? '配置你自己的共用 Telegram API，账号独立凭据仍优先使用。Hash 不回显，编辑留空保留原值。' : '配置项目共享的 Telegram API 与 AI 服务。密钥不回显，编辑留空保留原值。';
  document.querySelector('#global-services-scope').textContent=personal ? '仅我的账号' : '项目共享';
  document.querySelector('#system-settings-save-hint').textContent=personal ? '仅应用于你的账号；账号独立配置的 API 优先使用。' : '用户未设置个人服务时，自动继承这里的默认配置。';
  document.querySelector('#system-api-id-label').textContent=personal ? '我的 API ID' : '项目 API ID';
  document.querySelector('#system-api-hash-label').textContent=personal ? '我的 API Hash' : '项目 API Hash';
  document.querySelector('#system-settings-form [type=submit]').textContent=personal ? '保存 Telegram API' : '保存系统服务';

}
function settingsNavigationAllowed(view) {
  if(!['global-settings','admin-global-settings','ai'].includes(currentView) || currentView===view)return true;
  if(!globalSaving && !document.querySelector('#proxy-edit-dialog[open],#provider-edit-dialog[open],.ui-confirm-dialog[open]'))return true;
  if(location.hash!==`#${currentView}`)history.replaceState(null,'',`#${currentView}`);
  toast('请先完成或关闭当前设置操作',true);return false;
}
function applySettingsSummary(effective) {
  if(!effective)return;
  const label=key=>effective.sources?.[key]==='personal' ? '我的配置' : '管理员配置';
  document.querySelector('#settings-inheritance-summary').textContent=`当前生效：Telegram API · ${label('telegram')}；代理出口 · ${label('proxy')}。密钥不回显。`;
  if(config){readEditors();config.system=effective;renderConfig();}
}
function serviceTestText(kind,id) {
  const result=serviceTests.get(kind+':'+id);
  return result?.testing ? '测试中…' : result ? (result.ok ? result.latencyMs+' ms' : '连接失败') : '未测试';
}
function serviceTestStatus(kind,id) {
  const result=serviceTests.get(kind+':'+id);
  const state=result?.testing ? 'testing' : result ? (result.ok ? 'success' : 'failed') : 'idle';
  const hint=result?.message || (kind==='providers' ? '查询模型接口，不发送聊天请求' : '测试 Telegram HTTPS 连通耗时');
  return `<span class="service-status service-status-${state}" role="status" title="${escapeHtml(hint)}">${escapeHtml(serviceTestText(kind,id))}</span>`;
}
function serviceEmptyState(kind,loading=false) {
  const project=isProjectSettings();
  const title=loading ? '正在读取 AI 提供商' : kind==='proxies' ? '还没有添加出口代理' : '还没有添加 AI 提供商';
  const description=loading ? '请稍候，正在加载你的服务配置。' : kind==='proxies'
    ? (project ? '点击右上角添加代理，按名称管理并测试不同出口。' : '点击右上角添加你的代理；未配置时使用管理员默认出口。')
    : (project ? '添加共享 AI 服务，供用户选择或继承使用。' : '点击右上角添加个人服务；未配置时使用管理员默认 AI。');
  return `<tr class="service-empty-row"><td colspan="4"><div class="service-empty" role="status"><span class="service-empty-icon">${lineIcon(loading ? 'refresh' : kind==='proxies' ? 'layout' : 'ai')}</span><strong>${title}</strong><p>${description}</p></div></td></tr>`;
}
function serviceActions(kind,id) {
  return `<div class="service-actions"><button class="outline-btn service-test-btn" type="button" data-service-test="${kind}" data-service-id="${escapeHtml(id)}" ${serviceTests.get(kind+':'+id)?.testing ? 'disabled' : ''}>延迟测试</button><button class="outline-btn service-edit-btn" type="button" data-service-edit="${kind}" data-service-id="${escapeHtml(id)}">编辑</button><button class="delete-btn" type="button" data-service-delete="${kind}" data-service-id="${escapeHtml(id)}">删除</button></div>`;
}
function renderSystemSettings() {
  document.querySelector('#system-api-id').value=systemSettings.telegram.apiId || '';
  document.querySelector('#system-api-hash').value='';
  document.querySelector('#system-api-hash').placeholder=systemSettings.telegram.hasApiHash ? '已保存 · 留空保持不变' : '填写 API Hash';
  document.querySelector('#system-model').value=systemSettings.model || '';
  document.querySelector('#ai-model').value=systemSettings.model || '';
  renderSystemProviders();
}
function renderSystemProviders() {
  document.querySelector(currentView==='ai' ? '#ai-provider-list' : '#system-provider-list').innerHTML=systemSettings.providers.map(p=>`<tr class="service-row"><td><div class="service-identity"><span class="service-icon service-icon-ai">${lineIcon('ai')}</span><div><strong>${escapeHtml(p.name)}</strong><small class="service-tag">${escapeHtml(p.model || systemSettings.model || '默认模型未设置')}</small></div></div></td><td class="service-endpoint" data-label="Base URL"><code class="service-address">${escapeHtml(p.baseUrl)}</code></td><td class="service-state-cell" data-label="连接状态">${serviceTestStatus('providers',p.id)}</td><td class="service-actions-cell">${serviceActions('providers',p.id)}</td></tr>`).join('') || serviceEmptyState('providers');
}
function renderProxySettings() {
  const select=document.querySelector('#proxy-default');
  select.innerHTML='<option value="">'+(isProjectSettings() ? '不使用默认代理（直连）' : '跟随项目默认出口')+'</option>'+proxySettings.proxies.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${escapeHtml(p.type.toUpperCase())}</option>`).join('');
  select.value=proxySettings.defaultProxyId;
  document.querySelector('#proxy-list').innerHTML=proxySettings.proxies.map(p=>`<tr class="service-row"><td><div class="service-identity"><span class="service-icon service-icon-proxy">${lineIcon('layout')}</span><div><strong>${escapeHtml(p.name)}</strong>${p.id===proxySettings.defaultProxyId ? '<small class="service-tag service-tag-default">'+(isProjectSettings() ? '项目默认' : '我的默认')+'</small>' : ''}</div></div></td><td class="service-endpoint" data-label="协议 / 地址"><span class="service-tag service-protocol">${escapeHtml(p.type.toUpperCase())}</span><code class="service-address">${escapeHtml(p.host)}:${escapeHtml(p.port)}</code></td><td class="service-state-cell" data-label="连接状态">${serviceTestStatus('proxies',p.id)}</td><td class="service-actions-cell">${serviceActions('proxies',p.id)}</td></tr>`).join('') || serviceEmptyState('proxies');
  UIControls.refresh();
}
async function loadSystemSettings() {
  if (!webUser || globalSaving) return;
  const version=++serviceLoadVersion;serviceSettingsView=null;
  const view=currentView,base=settingsApi();renderSettingsScope();
  const [data,network]=await Promise.all([api(base+'/settings'),api(base+'/proxies')]);
  if(currentView!==view || serviceLoadVersion!==version)return;
  serviceSettingsView=view;
  systemSettings=data.settings;proxySettings=network;renderSystemSettings();renderProxySettings();
  applySettingsSummary(data.effective || data.settings);
}
document.querySelector('#global-settings-refresh').addEventListener('click',()=>loadSystemSettings().catch(error=>toast(error.message,true)));
async function loadAISettings() {
  if (globalSaving || currentView!=='ai') return;
  const version=++serviceLoadVersion;serviceSettingsView=null;
  document.querySelector('#ai-provider-list').innerHTML=serviceEmptyState('providers',true);
  const data=await api('/api/settings');
  if(currentView!=='ai' || serviceLoadVersion!==version)return;
  serviceSettingsView='ai';
  systemSettings=data.settings;renderSystemSettings();
  applySettingsSummary(data.effective);
}
document.querySelector('#ai-settings-refresh').addEventListener('click',()=>loadAISettings().catch(error=>toast(error.message,true)));
function openProxyEditor(id=null) {
  if(globalSaving)return;
  if(serviceSettingsView!==currentView){toast('设置正在加载，请稍后再试');return;}
  editingProxyId=id;
  const p=proxySettings.proxies.find(item=>item.id===id) || {name:'',type:'http',host:'',port:'',username:''};
  document.querySelector('#proxy-edit-title').textContent=id ? '编辑出口代理' : '添加出口代理';
  for(const field of ['name','type','host','port','username'])document.querySelector('#proxy-'+field).value=p[field];
  document.querySelector('#proxy-password').value='';
  document.querySelector('#proxy-password').placeholder=p.hasPassword ? '已保存 · 留空保持不变' : '无需认证时留空';
  document.querySelector('#proxy-clear-password').checked=false;
  document.querySelector('#proxy-error').hidden=true;UIControls.refresh();
  document.querySelector('#proxy-edit-dialog').showModal();document.querySelector('#proxy-name').focus();
}
function openProviderEditor(id=null) {
  if(globalSaving)return;
  if(serviceSettingsView!==currentView){toast('设置正在加载，请稍后再试');return;}
  editingProviderId=id;
  const p=systemSettings.providers.find(item=>item.id===id) || {};
  document.querySelector('#provider-edit-title').textContent=id ? '编辑 AI 提供商' : '添加 AI 提供商';
  document.querySelector('#provider-name').value=p.name || '';
  document.querySelector('#provider-model').value=p.model || '';
  document.querySelector('#provider-url').value=p.baseUrl || '';
  document.querySelector('#provider-key').value='';
  document.querySelector('#provider-key').placeholder=p.hasApiKey ? '已保存 · 留空保持不变' : '填写 API Key';
  document.querySelector('#provider-error').hidden=true;UIControls.refresh();
  document.querySelector('#provider-edit-dialog').showModal();document.querySelector('#provider-name').focus();
}
document.querySelector('#proxy-add').addEventListener('click',()=>openProxyEditor());
document.querySelector('#system-add-provider').addEventListener('click',()=>openProviderEditor());
document.querySelector('#ai-add-provider').addEventListener('click',()=>openProviderEditor());
document.addEventListener('click',event=>{const close=event.target.closest('[data-service-close]');if(close && !globalSaving)document.getElementById(close.dataset.serviceClose).close();});
async function saveProxyList(proxies,defaultProxyId) {
  if(serviceSettingsView!==currentView)throw Error('设置正在加载，请稍后再试');
  const data=await api(settingsApi()+'/proxies',{method:'PUT',body:JSON.stringify({proxies,defaultProxyId})});
  proxySettings=data;renderProxySettings();
  applySettingsSummary(data.effective);
}
document.querySelector('#proxy-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(globalSaving)return;globalSaving=true;
  const button=event.target.querySelector('[type="submit"]');button.disabled=true;
  const errorElement=document.querySelector('#proxy-error');errorElement.hidden=true;
  try {
    const entry={id:editingProxyId,enabled:true,name:document.querySelector('#proxy-name').value.trim(),type:document.querySelector('#proxy-type').value,host:document.querySelector('#proxy-host').value.trim(),port:document.querySelector('#proxy-port').value,username:document.querySelector('#proxy-username').value,password:document.querySelector('#proxy-password').value,clearPassword:document.querySelector('#proxy-clear-password').checked};
    const next=editingProxyId ? proxySettings.proxies.map(p=>p.id===editingProxyId ? entry : p) : [...proxySettings.proxies,entry];
    await saveProxyList(next,proxySettings.defaultProxyId);
    serviceTests.delete('proxies:'+editingProxyId);renderProxySettings();
    await document.querySelector('#proxy-edit-dialog').close();toast('代理已保存，可在账号配置中选择');
  } catch(error){errorElement.textContent=error.message;errorElement.hidden=false;}
  finally {button.disabled=false;globalSaving=false;}
});
document.querySelector('#proxy-default').addEventListener('change',async event=>{
  if(globalSaving){renderProxySettings();return;}globalSaving=true;event.target.disabled=true;
  try {await saveProxyList(proxySettings.proxies,event.target.value);toast(isProjectSettings() ? '项目默认出口已保存，监听任务已重连' : '我的账号默认出口已保存，仅重新连接我的监听任务');}
  catch(error){toast(error.message,true);renderProxySettings();}
  finally {event.target.disabled=false;globalSaving=false;}
});
async function saveSystemServices(providers=systemSettings.providers, clearTelegram=false, section=currentView==='ai' ? 'ai' : isProjectSettings() ? 'all' : 'telegram') {
  if(serviceSettingsView!==currentView)throw Error('设置正在加载，请稍后再试');
  const input={};
  if(section!=='ai')input.telegram={apiId:clearTelegram ? '' : document.querySelector('#system-api-id').value.trim(),apiHash:clearTelegram ? '' : document.querySelector('#system-api-hash').value.trim(),clear:clearTelegram};
  if(section!=='telegram')Object.assign(input,{model:document.querySelector(currentView==='ai' ? '#ai-model' : '#system-model').value.trim(),providers});
  const data=await api(settingsApi()+'/settings',{method:'PUT',body:JSON.stringify(input)});
  systemSettings=data.settings;renderSystemSettings();
  applySettingsSummary(data.effective || data.settings);
  return data;
}
document.querySelector('#provider-edit-form').addEventListener('submit',async event=>{
  event.preventDefault();if(globalSaving)return;globalSaving=true;
  const button=event.target.querySelector('[type="submit"]');button.disabled=true;
  const errorElement=document.querySelector('#provider-error');errorElement.hidden=true;
  try {
    const old=systemSettings.providers.find(p=>p.id===editingProviderId) || {};
    const entry={...old,name:document.querySelector('#provider-name').value.trim(),model:document.querySelector('#provider-model').value.trim(),baseUrl:document.querySelector('#provider-url').value.trim(),apiKey:document.querySelector('#provider-key').value.trim()};
    await saveSystemServices(editingProviderId ? systemSettings.providers.map(p=>p.id===editingProviderId ? entry : p) : [...systemSettings.providers,entry],false,'ai');
    serviceTests.delete('providers:'+editingProviderId);renderSystemProviders();
    await document.querySelector('#provider-edit-dialog').close();toast('AI 提供商已保存');
  } catch(error){errorElement.textContent=error.message;errorElement.hidden=false;}
  finally {button.disabled=false;globalSaving=false;}
});
document.querySelector('#system-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(globalSaving)return;globalSaving=true;const button=event.target.querySelector('[type="submit"]');button.disabled=true;
  try {await saveSystemServices();toast(isProjectSettings() ? '系统服务已保存' : '我的全局服务已保存');}catch(error){toast(error.message,true);}finally{button.disabled=false;globalSaving=false;}
});
document.querySelector('#ai-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(globalSaving)return;globalSaving=true;const button=event.target.querySelector('[type=submit]');button.disabled=true;
  try {await saveSystemServices();toast('AI 设置已保存');}catch(error){toast(error.message,true);}finally{button.disabled=false;globalSaving=false;}
});
document.addEventListener('click',async event=>{
  if(!event.target.closest('#view-global-settings,#view-ai'))return;
  const test=event.target.closest('[data-service-test]'),edit=event.target.closest('[data-service-edit]'),del=event.target.closest('[data-service-delete]');
  const button=test || edit || del;if(!button || button.disabled || globalSaving)return;
  if(serviceSettingsView!==currentView){toast('设置正在加载，请稍后再试');return;}
  const id=button.dataset.serviceId,kind=button.dataset.serviceTest || button.dataset.serviceEdit || button.dataset.serviceDelete;
  if(edit){kind==='proxies' ? openProxyEditor(id) : openProviderEditor(id);return;}
  if(test){
    const key=kind+':'+id;serviceTests.set(key,{testing:true});renderProxySettings();renderSystemProviders();
    try {const result=await api(`${settingsApi()}/${kind}/${encodeURIComponent(id)}/test`,{method:'POST',body:'{}'});serviceTests.set(key,result);}
    catch(error){serviceTests.set(key,{ok:false,message:error.message});toast(error.message,true);}
    finally{renderProxySettings();renderSystemProviders();}return;
  }
  const entry=(kind==='proxies' ? proxySettings.proxies : systemSettings.providers).find(p=>p.id===id);
  const accepted=await UIControls.confirm({title:kind==='proxies' ? '删除代理' : '删除 AI 提供商',message:`删除「${entry.name}」？仍被账号或用户选择的服务不能删除。`,confirmText:'删除'});
  if(!accepted || globalSaving)return;globalSaving=true;
  try {
    if(kind==='proxies')await saveProxyList(proxySettings.proxies.filter(p=>p.id!==id),proxySettings.defaultProxyId===id ? '' : proxySettings.defaultProxyId);
    else await saveSystemServices(systemSettings.providers.filter(p=>p.id!==id),false,'ai');
    serviceTests.delete(kind+':'+id);toast('已删除');
  } catch(error){toast(error.message,true);}finally{globalSaving=false;}
});
document.querySelector('#admin-profile-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
  try {const data=await api('/api/admin/profile',{method:'PATCH',body:JSON.stringify({username:document.querySelector('#admin-username').value.trim()})});renderWebUser(data.user);toast('管理员用户名已保存，下次登录请使用新用户名');}
  catch(error){toast(error.message,true);}finally{button.disabled=false;}
});

for(const [selector,kind] of [['#settings-reset-telegram','telegram'],['#settings-reset-ai','ai']]) {
  document.querySelector(selector).addEventListener('click',async event=>{
    if(globalSaving)return;
    if(!await UIControls.confirm({title:'恢复管理员配置',message:kind==='telegram' ? '清除我的全局 Telegram API，账号独立凭据仍优先使用。' : '清除我的 AI 提供商，之后自动使用管理员 AI。若有单独选择的提供商，请先在 AI 管理更改选择。',confirmText:'恢复'}))return;
    if(globalSaving)return;globalSaving=true;event.target.disabled=true;
    try {await saveSystemServices(kind==='ai' ? [] : systemSettings.providers,kind==='telegram',kind);toast('已恢复管理员配置');}
    catch(error){toast(error.message,true);}
    finally{globalSaving=false;event.target.disabled=false;}
  });
}
