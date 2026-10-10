let webUser = null;
window.renderWebUser = user => {
  webUser = user;
  document.querySelector('#nav-users').hidden = user.role !== 'admin';
  document.querySelector('#nav-audit').hidden = user.role !== 'admin';
  document.querySelector('#web-user-name').textContent = `${user.username} · ${user.role === 'admin' ? '管理员' : '用户'}`;
  document.querySelector('#web-password-link').hidden = user.role !== 'user';
};
async function loadWebUsers() {
  if (webUser?.role !== 'admin') return;
  try {
    const data = await api('/api/users');
    document.querySelector('#admin-username').value = webUser.username;
    await loadSystemSettings();
    document.querySelector('#web-users-list').innerHTML = data.users.length ? data.users.map(user=>`<tr data-web-user-id="${escapeHtml(user.id)}" data-web-username="${escapeHtml(user.username)}"><td>${escapeHtml(user.username)}</td><td><span class="count-pill">${user.mustChangePassword ? '待修改密码' : '已启用'}</span></td><td>${escapeHtml(formatDate(user.createdAt))}</td><td><div class="web-user-actions"><button class="outline-btn" type="button" data-web-user-action="edit">修改</button><button class="outline-btn" type="button" data-web-user-action="reset">重置密码</button><button class="delete-btn" type="button" data-web-user-action="delete">删除</button></div></td></tr>`).join('') : '<tr><td colspan="4">还没有普通用户，点击上方添加。</td></tr>';
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
function renderSystemSettings() {
  document.querySelector('#system-api-id').value = systemSettings.telegram.apiId || '';
  document.querySelector('#system-api-hash').value = '';
  document.querySelector('#system-api-hash').placeholder = systemSettings.telegram.hasApiHash ? '已保存 · 留空保持不变' : '填写 API Hash';
  document.querySelector('#system-model').value = systemSettings.model || '';
  renderSystemProviders();
}
function renderSystemProviders() {
  document.querySelector('#system-provider-list').innerHTML = systemSettings.providers.map((p,i)=>'<article class="system-provider" data-system-provider="'+i+'"><div class="system-section-heading"><strong>提供商 '+(i+1)+'</strong><button type="button" class="delete-btn" data-system-remove="'+i+'">删除</button></div><div class="field-grid"><label class="field"><span>名称</span><input data-system-field="name" value="'+escapeHtml(p.name || '')+'" required maxlength="80"></label><label class="field"><span>Base URL</span><input data-system-field="baseUrl" value="'+escapeHtml(p.baseUrl || '')+'" required placeholder="https://api.example.com/v1"></label><label class="field"><span>API Key</span><input data-system-field="apiKey" type="password" value="'+escapeHtml(p.apiKey || '')+'" autocomplete="new-password" placeholder="'+(p.hasApiKey ? '已保存 · 留空保持不变' : '填写 API Key')+'"></label></div></article>').join('') || '<p class="system-empty">尚未配置 AI 提供商</p>';
}
function readSystemProviders() {
  document.querySelectorAll('[data-system-provider]').forEach(card=>{
    const p = systemSettings.providers[Number(card.dataset.systemProvider)];
    card.querySelectorAll('[data-system-field]').forEach(input=>p[input.dataset.systemField]=input.value.trim());
  });
}
async function loadSystemSettings() {
  const [data,network] = await Promise.all([api('/api/admin/settings'),api('/api/admin/proxy')]);
  systemSettings=data.settings;renderSystemSettings();renderProxySettings(network.proxy);
}

function renderProxySettings(proxy) {
  document.querySelector('#proxy-enabled').checked=proxy.enabled;
  document.querySelector('#proxy-type').value=proxy.type;
  document.querySelector('#proxy-host').value=proxy.host;
  document.querySelector('#proxy-port').value=proxy.port;
  document.querySelector('#proxy-username').value=proxy.username;
  document.querySelector('#proxy-password').value='';
  document.querySelector('#proxy-password').placeholder=proxy.hasPassword ? '已保存 · 留空保持不变' : '填写代理密码';
  document.querySelector('#proxy-clear-password').checked=false;
  document.querySelector('#proxy-status').textContent=proxy.enabled ? proxy.type.toUpperCase()+' · 已启用' : '未启用';
  document.querySelector('#proxy-error').hidden=true;
  UIControls.refresh();
}
document.querySelector('#proxy-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('[type="submit"]');button.disabled=true;
  const errorElement=document.querySelector('#proxy-error');errorElement.hidden=true;
  try {
    const input={enabled:document.querySelector('#proxy-enabled').checked,type:document.querySelector('#proxy-type').value,
      host:document.querySelector('#proxy-host').value.trim(),port:document.querySelector('#proxy-port').value,
      username:document.querySelector('#proxy-username').value,password:document.querySelector('#proxy-password').value,
      clearPassword:document.querySelector('#proxy-clear-password').checked};
    const data=await api('/api/admin/proxy',{method:'PUT',body:JSON.stringify(input)});
    renderProxySettings(data.proxy);toast(data.proxy.enabled ? '出口代理已保存并启用，监听任务已重新连接' : '出口代理已关闭');
  } catch(error) {errorElement.textContent=error.message;errorElement.hidden=false;}
  finally {button.disabled=false;}
});
document.querySelector('#system-add-provider').addEventListener('click',()=>{
  readSystemProviders(); systemSettings.providers.push({sourceIndex:-1,name:'',baseUrl:'',apiKey:''});renderSystemProviders();
});
document.querySelector('#system-provider-list').addEventListener('click',event=>{
  const button = event.target.closest('[data-system-remove]'); if (!button) return;
  readSystemProviders();systemSettings.providers.splice(Number(button.dataset.systemRemove),1);renderSystemProviders();
});
document.querySelector('#admin-profile-form').addEventListener('submit',async event=>{
  event.preventDefault(); const button=event.target.querySelector('button');button.disabled=true;
  try {
    const data=await api('/api/admin/profile',{method:'PATCH',body:JSON.stringify({username:document.querySelector('#admin-username').value.trim()})});
    renderWebUser(data.user); toast('管理员用户名已保存，下次登录请使用新用户名');
  } catch(error) {toast(error.message,true);} finally {button.disabled=false;}
});
document.querySelector('#system-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('[type="submit"]');button.disabled=true;
  try {
    readSystemProviders();
    const input={telegram:{apiId:document.querySelector('#system-api-id').value.trim(),apiHash:document.querySelector('#system-api-hash').value.trim()},model:document.querySelector('#system-model').value.trim(),providers:systemSettings.providers};
    const data=await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(input)});
    readEditors();systemSettings=data.settings;renderSystemSettings();config.system=data.settings;renderConfig();
    toast(data.deferred ? '系统配置已保存，运行中的任务将在下次连接时使用新配置' : '系统配置已保存');
  } catch(error) {toast(error.message,true);} finally {button.disabled=false;}
});
