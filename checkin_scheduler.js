const timing = require('./schedule_time');
const fs = require('node:fs');
const path = require('node:path');

function beijingParts(date) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
}

function createScheduler({ root, readConfig, runAccount, isBusy, store = null, now = () => new Date(), rng = Math.random, intervalMs = 1000 }) {
  const file = path.join(root, '.checkin-schedule-state.json');
  let state = { claimed: {}, pending: [], events: [], planned: {} };
  let saved;
  try {
    const loaded = store ? structuredClone(store.read('checkin-state')) : JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      if (loaded.claimed && typeof loaded.claimed === 'object' && !Array.isArray(loaded.claimed)) state.claimed = loaded.claimed;
      if (Array.isArray(loaded.pending)) state.pending = loaded.pending.filter(item => item && typeof item.key === 'string' && typeof item.account === 'string');
      if (loaded.planned && typeof loaded.planned === 'object') state.planned = loaded.planned;
      if (Array.isArray(loaded.events)) state.events = loaded.events.slice(-30);
    }
  } catch (error) { if (error.code !== 'ENOENT') console.error('读取签到计划状态失败:', error); }
  // Keep a committed snapshot: a failed write must not consume an occurrence in memory.
  saved = JSON.stringify(state);
  let hasFile = store ? Boolean(store.read('checkin-state')) : fs.existsSync(file);
  let timer = null;
  let ticking = false;

  async function persist() {
    const serialized = JSON.stringify(state);
    if (hasFile && serialized === saved) return;
    const temp = `${file}.tmp`;
    try {
      if (store) await store.write('checkin-state', state);
      else {
        fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temp, file);
      }
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
        const rules = [...(user.checkin_schedules || []).map(rule => ({...rule, bot:null})),
          ...(!user.dialog_folder ? Object.entries(user.bot_schedules || {}).map(([bot, rule]) => ({ ...rule, id:`bot:${bot.toLowerCase()}`, bot, repeat:'daily', timeMode:'fixed' })) : [])];
        for (const rule of rules) {
          const occurrence = rule.repeat === 'daily' ? minute.slice(0, 10) : rule.time;
          // Tuple encoding avoids both cross-account collisions and delimiter ambiguity.
          const key = JSON.stringify([account, rule.id, occurrence]);
          const legacyKey = `${rule.id}:${occurrence}`;
          valid.add(key);
          if (rule.enabled === false) { delete state.planned[key]; continue; }
          active.set(JSON.stringify([account, rule.id]), rule);
          if (Object.hasOwn(state.claimed, legacyKey) && !Object.hasOwn(state.claimed, key)) state.claimed[key] = state.claimed[legacyKey];
          for (const item of state.pending) {
            if (item.account === account && item.key === legacyKey) {
              item.key = key;
              item.ruleId = rule.id;
            }
          }
          if (rule.repeat === 'daily' && rule.timeMode === 'random') {
            const fingerprint = timing.signature(rule);
            if (!state.planned[key] || (state.planned[key].signature !== fingerprint && !Object.hasOwn(state.claimed, key))) {
              const start = timing.seconds(rule.rangeStart), end = timing.seconds(rule.rangeEnd);
              if (end < start) throw new Error('不支持跨午夜随机区间');
              state.planned[key] = { account, ruleId: rule.id, date: occurrence, time: timing.clock(start + Math.floor(rng() * (end - start + 1))), signature: fingerprint };
            }
          } else delete state.planned[key];
          if (!Object.hasOwn(state.claimed, key) && timing.due(rule, current, state.planned[key])) {
            state.claimed[key] = current.toISOString();
            state.pending.push({ key, ruleId: rule.id, account, bot:rule.bot, name: user.name || user.session });
            event(rule.bot ? `${rule.bot} 独立定时已触发` : '签到计划已触发', 'info', account);
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
      for (const key of Object.keys(state.planned)) if (!valid.has(key)) delete state.planned[key];
      await persist();
      if (!isBusy() && state.pending.length) {
        const item = state.pending.shift();
        await persist();
        try {
          await runAccount(item.account, item.bot || null);
          event(item.bot ? `${item.bot} 独立签到已启动` : '定时签到已启动', 'info', item.account);
        } catch (error) { event(`定时签到启动失败：${error.message}`, 'error', item.account); }
        await persist();
      }
    } catch (error) { console.error('签到计划检查失败:', error); }
    finally { ticking = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    getState() { return { planned: Object.values(state.planned).map(({signature, ...plan}) => plan), queued: state.pending.length, events: state.events.slice(-20) }; }
  };
}

module.exports = { createScheduler, beijingParts };
