let webUser = null;
window.renderWebUser = user => {
  webUser = user;
  document.querySelector('#nav-users').hidden = user.role !== 'admin';
  document.querySelector('#web-user-name').textContent = `${user.username} · ${user.role === 'admin' ? '管理员' : '用户'}`;
  document.querySelector('#web-password-link').hidden = user.role !== 'user';
};
async function loadWebUsers() {
  if (webUser?.role !== 'admin') return;
  try {
    const data = await api('/api/users');
    document.querySelector('#web-users-list').innerHTML = data.users.length ? data.users.map(user=>`<tr><td>${escapeHtml(user.username)}</td><td><span class="count-pill">${user.mustChangePassword ? '待首次修改密码' : '已启用'}</span></td><td>${escapeHtml(formatDate(user.createdAt))}</td></tr>`).join('') : '<tr><td colspan="3">还没有普通用户，点击上方添加。</td></tr>';
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
api('/api/auth/status').then(data=>{
  if (data.user) { renderWebUser(data.user); if (location.hash === '#users') loadWebUsers(); }
}).catch(()=>{});
