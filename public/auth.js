'use strict';
const form = document.querySelector('#auth-form');
const password = document.querySelector('#admin-password');
const error = document.querySelector('#auth-error');
const submit = document.querySelector('#auth-submit');
const changeMode = location.pathname === '/password';
const username = document.querySelector('#auth-username');
if (changeMode) {
  document.querySelector('#auth-username-field').hidden = true; username.required = false;
  document.querySelector('#auth-new-fields').hidden = false;
  document.querySelector('#auth-new-password').required = true;
  document.querySelector('#auth-confirm-password').required = true;
  document.querySelector('.auth-card h1').textContent = '修改密码';
  document.querySelector('.auth-intro').textContent = '首次登录须修改初始密码，完成后进入独立工作空间。';
  document.querySelector('#auth-password-label').textContent = '原密码';
  submit.textContent = '保存新密码';
}
document.querySelector('#auth-reveal').addEventListener('click', event => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? '隐藏' : '显示';
  event.currentTarget.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  event.currentTarget.setAttribute('aria-pressed', String(visible));
  password.focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  error.textContent = ''; password.removeAttribute('aria-invalid'); submit.disabled = true;
  try {
    const newPassword = document.querySelector('#auth-new-password').value;
    if (changeMode && newPassword !== document.querySelector('#auth-confirm-password').value) throw new Error('两次输入的新密码不一致');
    const response = await fetch(changeMode ? '/api/auth/password' : '/api/auth/login', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(changeMode ? {currentPassword:password.value,newPassword} : {username:username.value,password:password.value}) });
    const data = await response.json();
    password.value = '';
    if (!response.ok) throw new Error(data.error || '登录失败，请重试。');
    location.replace(data.user?.mustChangePassword ? '/password' : '/');
  } catch (err) {
    error.textContent = err.message || '无法连接服务器，请稍后重试。';
    password.setAttribute('aria-invalid', 'true'); password.focus();
  } finally { submit.disabled = false; }
});
fetch('/api/auth/status').then(r => r.json()).then(data => {
  if (!changeMode && data.adminUsername && username.value === 'admin') username.value = data.adminUsername;
  if (data.authenticated && !changeMode) location.replace(data.user?.mustChangePassword ? '/password' : '/');
  else if (changeMode && !data.authenticated) location.replace('/login');
  else if (changeMode && data.user?.role === 'admin') location.replace('/');
  else if (changeMode && data.user && !data.user.mustChangePassword) document.querySelector('.auth-intro').textContent = '修改当前账号密码，其他浏览器的登录会话将失效。';
  else if (!data.configured) error.textContent = '管理员密码尚未配置，请设置 ADMIN_PASSWORD 后重启服务。';
}).catch(() => { error.textContent = '无法连接服务器，请稍后重试。'; });
