// All schedule wall times are Beijing time (UTC+08:00).
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
function seconds(value) {
  const match = CLOCK.exec(value || '');
  if (!match) throw new Error('时间必须为 HH:mm 或 HH:mm:ss');
  return +match[1] * 3600 + +match[2] * 60 + +(match[3] || 0);
}
function clock(value) { return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':'); }
function validateTime(item, label) {
  const repeat = item.repeat;
  if (!['daily', 'once'].includes(repeat)) throw new Error(`${label} 的频率无效`);
  const timeMode = item.timeMode || 'fixed';
  if (!['fixed', 'random'].includes(timeMode) || (repeat === 'once' && timeMode !== 'fixed')) throw new Error(`${label}：区间随机仅支持每天执行`);
  if (timeMode === 'random') {
    const start = seconds(item.rangeStart), end = seconds(item.rangeEnd);
    if (start > end) throw new Error(`${label}：不支持跨午夜区间，开始时间必须不晚于结束时间`);
    return { repeat, timeMode, rangeStart: clock(start), rangeEnd: clock(end) };
  }
  const time = String(item.time || '').trim();
  if (repeat === 'daily') seconds(time);
  else {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(time)) throw new Error(`${label} 的日期无效`);
    seconds(time.slice(11));
    const normalized = time.length === 16 ? `${time}:00` : time;
    const parsed = new Date(`${normalized}+08:00`);
    if (!Number.isFinite(parsed.getTime()) || new Date(parsed.getTime() + 28800000).toISOString().slice(0, 19) !== normalized) throw new Error(`${label} 的日期无效`);
  }
  return { repeat, timeMode, time };
}
function signature(rule) { return JSON.stringify([rule.repeat, rule.timeMode || 'fixed', rule.timeMode === 'random' ? rule.rangeStart : rule.time, rule.timeMode === 'random' ? rule.rangeEnd : null]); }
function due(rule, current, plan) {
  const wall = new Date(current.getTime() + 28800000).toISOString().slice(0, 19);
  const random = rule.timeMode === 'random';
  const value = random ? plan?.time : rule.time;
  if (!value) return false;
  const target = rule.repeat === 'daily' ? `${wall.slice(0, 10)}T${value.length === 5 ? value + ':00' : value}` : (value.length === 16 ? value + ':00' : value);
  const elapsed = current.getTime() - new Date(`${target}+08:00`).getTime();
  const grace = rule.repeat === 'once' ? 300000 : (!random && value.length === 5 ? 60000 : 10000);
  return elapsed >= 0 && elapsed < grace;
}
module.exports = { seconds, clock, validateTime, signature, due };
