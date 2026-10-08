(() => {
  let loading=false,initialized=false;
  const errors=$('#notification-error');
  function renderStatus(settings) {
    $('#notification-deliveries').innerHTML=settings.deliveries.map(item=>'<tr><td>'+escapeHtml(formatDate(item.finishedAt || item.createdAt))+'</td><td>'+escapeHtml(item.kind==='test' ? '测试通知' : config?.users.find(user=>user.session===item.account)?.name || item.account || '定时签到')+'</td><td><span class="count-pill">'+escapeHtml(({pending:'等待发送',sending:'发送中',sent:'已发送',failed:'发送失败',cancelled:'已取消'})[item.state] || item.state)+'</span></td><td>'+escapeHtml(item.error || (item.state==='sent' ? '已推送到 Telegram' : '尝试 '+item.attempts+' 次'))+'</td></tr>').join('') || '<tr><td colspan="4">尚无通知记录。</td></tr>';
  }
  window.loadNotificationSettings=async()=>{
    if(loading)return;loading=true;
    try {
      const {notifications}=await api('/api/notifications');renderStatus(notifications);
      if(!initialized) {
        $('#notification-enabled').checked=notifications.enabled;
        $('#notification-chat').value=notifications.chatId || '';
        $('#notification-token').placeholder=notifications.hasToken ? '已保存 · 留空保持不变' : '从 @BotFather 获取';
        initialized=true;
      }
    }catch(e){errors.hidden=false;errors.textContent=e.message;}
    finally{loading=false;}
  };
  async function save() {
    const {notifications}=await api('/api/notifications',{method:'PUT',body:JSON.stringify({enabled:$('#notification-enabled').checked,botToken:$('#notification-token').value.trim(),chatId:$('#notification-chat').value.trim()})});
    $('#notification-token').value='';$('#notification-token').placeholder=notifications.hasToken ? '已保存 · 留空保持不变' : '从 @BotFather 获取';renderStatus(notifications);
  }
  $('#notification-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.target.querySelector('[type="submit"]');button.disabled=true;errors.hidden=true;
    try {await save();toast('通知设置已保存');}catch(e){errors.hidden=false;errors.textContent=e.message;}finally{button.disabled=false;}
  });
  $('#notification-test').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;errors.hidden=true;
    try {await save();const {notifications}=await api('/api/notifications/test',{method:'POST',body:'{}'});renderStatus(notifications);toast('测试通知已加入发送队列，请查看发送状态');}
    catch(e){errors.hidden=false;errors.textContent=e.message;}finally{button.disabled=false;}
  });
  $('#notification-refresh').addEventListener('click',loadNotificationSettings);
  const timer=setInterval(()=>{if(currentView==='notifications' && !document.hidden)loadNotificationSettings();},3000);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
