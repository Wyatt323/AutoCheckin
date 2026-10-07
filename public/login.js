// Login UI keeps passwords in an input/request only, never in config or storage.
let loginState = null;
let dismissedLoginId = null;
let refreshedLoginId = null;
let refreshingLoginId = null;
let profileStarting = false;
const attemptedProfiles = new Set();
const manualProfiles = new Set();
let profileErrorId = null;
const loginDialog = document.createElement('dialog');
loginDialog.id = 'login-dialog';
loginDialog.setAttribute('aria-labelledby', 'login-title');
loginDialog.innerHTML = `<h2 id="login-title">Telegram 登录</h2><p id="login-account"></p><p id="login-status" role="status" aria-live="polite"></p><img id="login-qr" alt="Telegram 登录二维码" width="260" height="260" hidden><p>手机 Telegram → 设置 → 设备 → 连接桌面设备。二维码仅用于此账号登录，请勿分享。</p><form id="login-password-form" hidden><label>两步验证密码<input id="login-password" type="password" maxlength="256" autocomplete="off" required></label><button type="submit" class="outline-btn">验证密码</button></form><button id="login-cancel" type="button" class="outline-btn">取消登录</button>`;
document.body.append(loginDialog);
function renderLogin(state) {
  const previous = loginState;
  loginState = state;
  $$('.save-btn,#hero-run,#account-run,#restart-automation,[data-run-account],[data-login-account],[data-profile-account]').forEach(button => {
    button.disabled = state.active || (typeof startingRun !== 'undefined' && startingRun) || ['running','stopping'].includes(currentRun?.state) || (button.classList.contains('save-btn') && typeof savingConfig !== 'undefined' && savingConfig) || (button.dataset.profileAccount !== undefined && !config?.users[Number(button.dataset.profileAccount)]?.sessionReady);
    if (button.dataset.profileAccount !== undefined) {
      const syncing = state.active && state.mode === 'profile' && config?.users[Number(button.dataset.profileAccount)]?.session === state.account;
      const label = button.querySelector('span');
      if (label) label.textContent = syncing ? '同步中' : '同步资料';
      else button.textContent = syncing ? '↻ 正在同步' : '↻ 同步 TG 资料';
    }
  });
  if (state.state === 'idle' || dismissedLoginId === state.id) return;
  if ((!loginDialog.open || loginDialog.classList?.contains('ui-dialog-closing')) && state.active && state.mode !== 'profile') loginDialog.showModal();
  $('#login-account').textContent = state.account || '';
  $('#login-status').textContent = state.message || '正在准备登录';
  const image = $('#login-qr');
  image.hidden = state.state !== 'qr' || !state.png;
  if (!image.hidden) image.src = `data:image/png;base64,${state.png}`;
  else image.removeAttribute('src');
  $('#login-password-form').hidden = state.state !== 'password_required';
  if (state.state === 'password_required' && previous?.state !== state.state) $('#login-password').focus();
  $('#login-cancel').textContent = state.active ? '取消登录' : '关闭';
  if (state.state === 'success' && !state.active && refreshedLoginId !== state.id && refreshingLoginId !== state.id && config) {
    const completedId = state.id;
    refreshingLoginId = completedId;
    api('/api/state').then(data => {
      if (loginState?.id !== completedId) return;
      readEditors(); // Preserve unsaved settings while updating read-only Telegram data.
      config.users.forEach(user => {
        const saved = data.config.users.find(saved => saved.session === user.session);
        user.sessionReady = saved?.sessionReady || false;
        user.profile = saved?.profile || null;
      });
      renderConfig();
      if (loginState?.id === completedId && loginState.state === 'success' && !loginState.active) {
        refreshedLoginId = completedId;
        dismissedLoginId = completedId;
        $('#login-password').value = '';
        $('#login-qr').removeAttribute('src');
        loginDialog.close();
        if (state.mode !== 'profile' || manualProfiles.has(state.id)) toast(state.mode === 'profile' ? 'Telegram 头像与资料已同步' : 'Telegram 登录成功');
        manualProfiles.delete(state.id);
      }
    }).catch(error => toast(error.message, true)).finally(() => { if (refreshingLoginId === completedId) refreshingLoginId = null; });
  }
  if (state.mode === 'profile' && state.state === 'error' && !state.active && profileErrorId !== state.id) {
    profileErrorId = state.id;
    if (manualProfiles.delete(state.id)) toast(state.message || 'Telegram 资料同步失败', true);
  }
}
async function syncAccountProfile(user, manual = false) {
  if (profileStarting || loginState?.active || savingConfig || ['running','stopping'].includes(currentRun?.state)) return;
  if (user.sourceIndex < 0 || !user.sessionReady) { if (manual) toast('请先保存账号并登录 Telegram', true); return; }
  profileStarting = true;
  attemptedProfiles.add(user.session);
  try {
    const state = (await api('/api/accounts/profile/refresh', { method:'POST', body:JSON.stringify({ account:user.session }) })).login;
    if (manual) manualProfiles.add(state.id);
    renderLogin(state);
  } catch (error) { if (manual) toast(error.message, true); }
  finally { profileStarting = false; }
}
function queueAccountProfiles() {
  if (typeof currentView === 'undefined' || currentView !== 'accounts' || refreshingLoginId || profileStarting || loginState?.active || savingConfig) return;
  const user = config?.users.find(user => user.sourceIndex >= 0 && user.sessionReady && !user.profile && !attemptedProfiles.has(user.session));
  if (user) syncAccountProfile(user);
}
async function pollLogin() {
  try { renderLogin((await api('/api/login/status')).login); queueAccountProfiles(); }
  catch (error) { if (loginDialog.open) $('#login-status').textContent = `状态读取失败：${error.message}`; }
}
document.addEventListener('click', async event => {
  const profileButton = event.target.closest('[data-profile-account]');
  if (profileButton) {
    const user = config?.users[Number(profileButton.dataset.profileAccount)];
    if (user) await syncAccountProfile(user, true);
    return;
  }
  const button = event.target.closest('[data-login-account]');
  if (!button) return;
  const user = config?.users[Number(button.dataset.loginAccount)];
  if (!user) return;
  if (user.sourceIndex < 0) { toast('请先保存账号名称和 Session，再登录', true); return; }
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
const loginPollTimer = setInterval(pollLogin, 1000);
window.addEventListener('pagehide', () => clearInterval(loginPollTimer), { once: true });
