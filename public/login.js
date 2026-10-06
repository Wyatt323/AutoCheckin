// Login UI keeps passwords in an input/request only, never in config or storage.
let loginState = null;
let dismissedLoginId = null;
const loginDialog = document.createElement('dialog');
loginDialog.id = 'login-dialog';
loginDialog.setAttribute('aria-labelledby', 'login-title');
loginDialog.innerHTML = `<h2 id="login-title">Telegram 登录</h2><p id="login-account"></p><p id="login-status" role="status" aria-live="polite"></p><img id="login-qr" alt="Telegram 登录二维码" width="260" height="260" hidden><p>手机 Telegram → 设置 → 设备 → 连接桌面设备。二维码仅用于此账号登录，请勿分享。</p><form id="login-password-form" hidden><label>两步验证密码<input id="login-password" type="password" maxlength="256" autocomplete="off" required></label><button type="submit" class="outline-btn">验证密码</button></form><button id="login-cancel" type="button" class="outline-btn">取消登录</button>`;
document.body.append(loginDialog);
function renderLogin(state) {
  const previous = loginState;
  loginState = state;
  $$('.save-btn,#hero-run,#activity-run,#account-run,#restart-automation,[data-run-account],[data-login-account]').forEach(button => { button.disabled = state.active || ['running','stopping'].includes(currentRun?.state); });
  if (state.state === 'idle' || dismissedLoginId === state.id) return;
  if (!loginDialog.open && state.active) loginDialog.showModal();
  $('#login-account').textContent = state.account || '';
  $('#login-status').textContent = state.message || '正在准备登录';
  const image = $('#login-qr');
  image.hidden = state.state !== 'qr' || !state.png;
  if (!image.hidden) image.src = `data:image/png;base64,${state.png}`;
  else image.removeAttribute('src');
  $('#login-password-form').hidden = state.state !== 'password_required';
  if (state.state === 'password_required' && previous?.state !== state.state) $('#login-password').focus();
  $('#login-cancel').textContent = state.active ? '取消登录' : '关闭';
  if (state.state === 'success' && !state.active && previous?.active) {
    api('/api/state').then(data => {
      config.users.forEach(user => { user.sessionReady = data.config.users.find(saved => saved.session === user.session)?.sessionReady || false; });
      renderConfig();
    }).catch(error => toast(error.message, true));
  }
}
async function pollLogin() {
  try { renderLogin((await api('/api/login/status')).login); }
  catch (error) { if (loginDialog.open) $('#login-status').textContent = `状态读取失败：${error.message}`; }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-login-account]');
  if (!button) return;
  const user = config?.users[Number(button.dataset.loginAccount)];
  if (!user) return;
  if (user.sourceIndex < 0 || !user.hasApiHash) { toast('请先保存账号名称、Session 和 API 凭据，再登录', true); return; }
  button.disabled = true;
  try { dismissedLoginId = null; renderLogin((await api('/api/login/start', { method:'POST', body:JSON.stringify({ account:user.session }) })).login); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
$('#login-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#login-password');
  const body = JSON.stringify({ id:loginState.id, password:input.value });
  input.value = '';
  try { renderLogin((await api('/api/login/password', { method:'POST', body })).login); }
  catch (error) { toast(error.message, true); }
});
async function closeLogin() {
  try {
    if (loginState?.active) renderLogin((await api('/api/login/cancel', { method:'POST', body:JSON.stringify({ id:loginState.id }) })).login);
    dismissedLoginId = loginState?.id;
    $('#login-password').value = '';
    $('#login-qr').removeAttribute('src');
    loginDialog.close();
  } catch (error) { toast(error.message, true); }
}
$('#login-cancel').addEventListener('click', closeLogin);
loginDialog.addEventListener('cancel', event => { event.preventDefault(); closeLogin(); });
pollLogin();
setInterval(pollLogin, 1000);
