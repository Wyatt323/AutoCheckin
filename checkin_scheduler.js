const fs = require('node:fs');
const path = require('node:path');

function beijingParts(date) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
}

function createScheduler({ root, readConfig, runAccount, isBusy, now = () => new Date(), intervalMs = 5000 }) {
  const file = path.join(root, '.checkin-schedule-state.json');
  let state = { claimed: {}, pending: [], events: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') console.error('读取签到计划状态失败:', error); }
  let timer = null;
  let ticking = false;
  state.pending ||= [];
  const queue = state.pending;

  function persist() {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function event(message, level = 'info', account = null) {
    state.events.push({ time: now().toISOString(), message, level, account });
    state.events = state.events.slice(-30);
    persist();
  }
  function due(rule, minute, timestamp) {
    if (rule.enabled === false) return false;
    if (rule.repeat === 'daily') return rule.time === minute.slice(11);
    if (rule.repeat === 'once') {
      const dueAt = new Date(`${rule.time}:00+08:00`).getTime();
      return Number.isFinite(dueAt) && timestamp >= dueAt && timestamp < dueAt + 5 * 60000;
    }
    return false;
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const current = now();
      const minute = beijingParts(current);
      const users = readConfig().telegram?.users || [];
      const valid = new Set();
      const activeIds = new Set();
      for (const user of users) {
        for (const rule of user.checkin_schedules || []) {
          if (rule.enabled === false) continue;
          activeIds.add(`${user.session || user.name}:${rule.id}`);
          const key = `${rule.id}:${rule.repeat === 'daily' ? minute.slice(0, 10) : rule.time}`;
          valid.add(key);
          if (!state.claimed[key] && due(rule, minute, current.getTime())) {
            state.claimed[key] = current.toISOString();
            queue.push({ key, account: user.session || user.name, name: user.name || user.session });
            event(`签到计划已触发`, 'info', user.session || user.name);
          }
        }
      }
      for (let index = queue.length - 1; index >= 0; index--) {
        if (!activeIds.has(`${queue[index].account}:${queue[index].key.split(':')[0]}`)) queue.splice(index, 1);
      }
      for (const key of Object.keys(state.claimed)) if (!valid.has(key) && !queue.some(item => item.key === key)) delete state.claimed[key];
      persist();
      if (!isBusy() && queue.length) {
        const item = queue.shift();
        persist();
        try {
          await runAccount(item.account);
          event(`定时签到已启动`, 'info', item.account);
        } catch (error) { event(`定时签到启动失败：${error.message}`, 'error', item.account); }
      }
    } catch (error) { console.error('签到计划检查失败:', error); }
    finally { ticking = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    getState() { return { queued: queue.length, events: state.events.slice(-20) }; }
  };
}

module.exports = { createScheduler, beijingParts };
