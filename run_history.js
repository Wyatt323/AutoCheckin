const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_RUNS = 30, MAX_LINES = 3000, PER_RUN_LINES = 800;
function createRunHistory(dataRoot) {
  const file = path.join(dataRoot, 'logs', 'run-history.json');
  let records = [], revision = 0, timer = null;
  function trim() {
    records = records.slice(-MAX_RUNS);
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
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, records }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) { console.error(`运行历史保存失败：${error.message}`); }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    records = Array.isArray(saved.records) ? saved.records.filter(r => r && typeof r.id === 'string' && Array.isArray(r.lines)) : [];
    for (const record of records) {
      if (['running', 'stopping'].includes(record.state)) {
        record.state = 'failed'; record.finishedAt = new Date().toISOString();
        record.lines.push({ id: (record.lines.at(-1)?.id || 0) + 1, time: record.finishedAt, stream: 'system', text: '服务重启，本次任务已中断', runId: record.id, account: record.account, trigger: record.trigger });
      }
    }
    trim();
    if (records.length) flush();
  } catch (error) { if (error.code !== 'ENOENT') console.error(`运行历史读取失败：${error.message}`); }
  function changed(immediate = false) {
    revision++; trim();
    if (immediate) flush();
    else if (!timer) { timer = setTimeout(flush, 250); timer.unref(); }
  }
  return {
    create(account, trigger) {
      const record = { id: randomUUID(), account: account || null, trigger, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, lines: [] };
      records.push(record); changed(true); return record;
    },
    changed, flush,
    latest: () => records.at(-1),
    snapshot: () => ({ revision, records }),
    find: id => records.find(record => record.id === id)
  };
}
module.exports = { createRunHistory, MAX_RUNS, MAX_LINES, PER_RUN_LINES };
