const fs = require('node:fs');
const path = require('node:path');

function beijingParts(date) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
}

function createScheduler({ root, readConfig, runAccount, isBusy, now = () => new Date(), intervalMs = 5000 }) {
  const file = path.join(root, '.checkin-schedule-state.json');
  let state = { claimed: {}, pending: [], events: [] };
  let saved;
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      if (loaded.claimed && typeof loaded.claimed === 'object' && !Array.isArray(loaded.claimed)) state.claimed = loaded.claimed;
      if (Array.isArray(loaded.pending)) state.pending = loaded.pending.filter(item => item && typeof item.key === 'string' && typeof item.account === 'string');
      if (Array.isArray(loaded.events)) state.events = loaded.events.slice(-30);
    }
  } catch (error) { if (error.code !== 'ENOENT') console.error('读取签到计划状态失败:', error); }
  // Keep a committed snapshot: a failed write must not consume an occurrence in memory.
  saved = JSON.stringify(state);
  let hasFile = fs.existsSync(file);
  let timer = null;
  let ticking = false;

  function persist() {
    const serialized = JSON.stringify(state);
    if (hasFile && serialized === saved) return;
    const temp = `${file}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
      saved = serialized;
      hasFile = true;
    } catch (error) {
      state = JSON.parse(saved);
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  }
  function event(message, level = 'info', account = null) {
    state.events.push({ time: now().toISOString(), message, level, account });
    state.events = state.events.slice(-30);
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
      const active = new Map();
      for (const user of users) {
        const account = user.session || user.name;
        if (!account) continue;
        for (const rule of user.checkin_schedules || []) {
          if (rule.enabled === false) continue;
          const occurrence = rule.repeat === 'daily' ? minute.slice(0, 10) : rule.time;
          // Tuple encoding avoids both cross-account collisions and delimiter ambiguity.
          const key = JSON.stringify([account, rule.id, occurrence]);
          const legacyKey = `${rule.id}:${occurrence}`;
          valid.add(key);
          active.set(JSON.stringify([account, rule.id]), rule);
          if (Object.hasOwn(state.claimed, legacyKey) && !Object.hasOwn(state.claimed, key)) state.claimed[key] = state.claimed[legacyKey];
          for (const item of state.pending) {
            if (item.account === account && item.key === legacyKey) {
              item.key = key;
              item.ruleId = rule.id;
            }
          }
          if (!Object.hasOwn(state.claimed, key) && due(rule, minute, current.getTime())) {
            state.claimed[key] = current.toISOString();
            state.pending.push({ key, ruleId: rule.id, account, name: user.name || user.session });
            event('签到计划已触发', 'info', account);
          }
        }
      }
      state.pending = state.pending.filter(item => {
        const rule = active.get(JSON.stringify([item.account, item.ruleId]));
        if (!rule) return false;
        // A changed one-shot time invalidates the old queued occurrence.
        try { return rule.repeat === 'daily' || JSON.parse(item.key)[2] === rule.time; } catch { return false; }
      });
      const queuedKeys = new Set(state.pending.map(item => item.key));
      for (const key of Object.keys(state.claimed)) if (!valid.has(key) && !queuedKeys.has(key)) delete state.claimed[key];
      persist();
      if (!isBusy() && state.pending.length) {
        const item = state.pending.shift();
        persist();
        try {
          await runAccount(item.account);
          event('定时签到已启动', 'info', item.account);
        } catch (error) { event(`定时签到启动失败：${error.message}`, 'error', item.account); }
        persist();
      }
    } catch (error) { console.error('签到计划检查失败:', error); }
    finally { ticking = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    getState() { return { queued: state.pending.length, events: state.events.slice(-20) }; }
  };
}

module.exports = { createScheduler, beijingParts };
