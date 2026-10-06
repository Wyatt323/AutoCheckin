'use strict';
const form = document.querySelector('#auth-form');
const password = document.querySelector('#admin-password');
const error = document.querySelector('#auth-error');
const submit = document.querySelector('#auth-submit');
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
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
    const data = await response.json();
    password.value = '';
    if (!response.ok) throw new Error(data.error || '登录失败，请重试。');
    location.replace('/');
  } catch (err) {
    error.textContent = err.message || '无法连接服务器，请稍后重试。';
    password.setAttribute('aria-invalid', 'true'); password.focus();
  } finally { submit.disabled = false; }
});
fetch('/api/auth/status').then(r => r.json()).then(data => {
  if (data.authenticated) location.replace('/');
  else if (!data.configured) error.textContent = '管理员密码尚未配置，请设置 ADMIN_PASSWORD 后重启服务。';
}).catch(() => { error.textContent = '无法连接服务器，请稍后重试。'; });
