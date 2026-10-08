const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_RUNS = 30, MAX_LINES = 3000, PER_RUN_LINES = 800;
const MAX_EVENTS = 1000;
function createRunHistory(dataRoot, store = null) {
  const file = path.join(dataRoot, 'logs', 'run-history.json');
  let records = [], events = [], revision = 0, timer = null;
  function trim() {
    records = records.slice(-MAX_RUNS);
    events = events.slice(-MAX_EVENTS);
    let remaining = MAX_LINES;
    for (let i = records.length - 1; i >= 0; i--) {
      const count = Math.min(PER_RUN_LINES, remaining);
      records[i].lines = count ? records[i].lines.slice(-count) : [];
      remaining -= records[i].lines.length;
    }
  }
  function flush() {
    clearTimeout(timer); timer = null;
    try {
      trim();
      if (store) return store.write('run-history', {version:2, records, events}).catch(() => { console.error('运行历史保存到数据库失败'); throw new Error('日志存储失败'); });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 2, records, events }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) { console.error(`运行历史保存失败：${error.message}`); }
  }
  try {
    const saved = store ? structuredClone(store.read('run-history') || {}) : JSON.parse(fs.readFileSync(file, 'utf8'));
    records = Array.isArray(saved.records) ? saved.records.filter(r => r && typeof r.id === 'string' && Array.isArray(r.lines)) : [];
    events = Array.isArray(saved.events) ? saved.events.filter(r => r && typeof r.id === 'string' && typeof r.account === 'string' && ['message','forward'].includes(r.category) && Array.isArray(r.lines)) : [];
    for (const record of records) {
      if (['running', 'stopping'].includes(record.state)) {
        record.state = 'failed'; record.finishedAt = new Date().toISOString();
        for (const account of Object.keys(record.accountStates || {})) if (record.accountStates[account] === 'running') record.accountStates[account] = 'failed';
        record.lines.push({ id: (record.lines.at(-1)?.id || 0) + 1, time: record.finishedAt, stream: 'system', text: '服务重启，本次任务已中断', runId: record.id, account: record.account, trigger: record.trigger });
      }
    }
    trim();
    if (records.length || events.length) Promise.resolve(flush()).catch(() => {});
  } catch (error) { if (error.code !== 'ENOENT') console.error(`运行历史读取失败：${error.message}`); }
  function changed(immediate = false) {
    revision++; trim();
    if (immediate) Promise.resolve(flush()).catch(() => {});
    else if (!timer) { timer = setTimeout(() => Promise.resolve(flush()).catch(() => {}), 250); timer.unref(); }
  }
  return {
    create(account, trigger) {
      const record = { id: randomUUID(), category:'checkin', account: account || null, trigger, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, lines: [] };
      records.push(record); changed(true); return record;
    },
    changed, flush,
    appendEvent(event) {
      if (!event || typeof event.account !== 'string' || !['message','forward'].includes(event.category)) return;
      const time = new Date().toISOString(), id = randomUUID();
      const state = ['completed','failed','running','stopped'].includes(event.state) ? event.state : event.level === 'error' ? 'failed' : 'completed';
      events.push({ id, account:event.account, category:event.category, ruleId:event.ruleId, trigger:event.category === 'forward' ? 'automatic' : 'scheduled', state, startedAt:time, finishedAt:time,
        lines:[{ id:1, time, stream:event.level === 'error' ? 'stderr' : 'system', text:String(event.message || '').slice(0,2000) }] });
      changed();
    },
    latest: () => records.at(-1),
    snapshot: ({ account = '', category = '' } = {}) => {
      let selected = [...records, ...events].sort((a,b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      if (category) selected = selected.filter(record => (record.category || 'checkin') === category);
      if (account === '__all__') selected = selected.filter(record => !record.account);
      else if (account) selected = selected.flatMap(record => {
        const lines = record.lines.filter(line => (line.account || record.account) === account);
        const botResults=record.botResults?.filter(item=>item.account===account);
        if (record.account !== account && !lines.length && !botResults?.length) return [];
        const state = typeof record.accountStates?.[account] === 'string' ? record.accountStates[account] : record.state;
        return [{ ...record, accountStates:undefined, account, state, lines, ...(botResults ? {botResults} : {}) }];
      });
      return { revision, records:selected };
    },
    find: id => records.find(record => record.id === id)
  };
}
module.exports = { createRunHistory, MAX_RUNS, MAX_LINES, PER_RUN_LINES, MAX_EVENTS };
