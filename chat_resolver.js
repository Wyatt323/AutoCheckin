const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCredentials } = require('./telegram_credentials');
const chatInputError = '输入错误或账号未加入';
const lookupErrors = {
  numeric_peer_not_found:chatInputError,
  access_denied:chatInputError,
  invalid_username:chatInputError,
  timeout:'名称查询超时，请稍后重试',
  rate_limit:'查询触发限流，请稍后重试'
};

function createChatResolver({ workerEnv = {},root, dataDir, readConfig, pythonCommand, spawnWorker=spawn, timeoutMs=45000, stopGraceMs=2000}) {
  const cache = new Map(), pending = new Map(), jobs = new Map();
  let closed = false;
  let stopping;
  async function resolve(account, peers) {
    if (closed) throw new Error('服务正在停止');
    if (typeof account !== 'string' || !/^[\w.-]+$/.test(account) || ['.','..'].includes(account)) throw new Error('账号无效');
    const config = readConfig(), user = (config.telegram?.users || config.users || []).find(user => (user.session || user.name) === account);
    if (!user) throw new Error('账号不存在');
    if (!Array.isArray(peers) || !peers.length || peers.length>4 || peers.some(value => typeof value !== 'string' || !value.trim() || value.length>120)) throw new Error('名称查询参数无效');
    if (!fs.existsSync(path.join(dataDir, `${account}.session`))) throw new Error('请先登录此账号的 Telegram');
    resolveCredentials(config, user);
    const stamp = fs.statSync(path.join(dataDir, `${account}.session`)).mtimeMs;
    const key = value => JSON.stringify([account, stamp, value.trim().toLowerCase()]);
    const valid = value => /^(?:-?\d{1,20}|@?[A-Za-z][A-Za-z0-9_]{4,31}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?)$/i.test(value.trim());
    // Retain this request's results even if another batch evicts its cache entries.
    const results = new Map(peers.map(value => [value, cache.get(key(value))]));
    const wanted = [...new Set(peers)].filter(value => valid(value) && (results.get(value)?.expires || 0) <= Date.now());
    if (wanted.length) {
      const batchKey = JSON.stringify([account, stamp, wanted.slice().sort()]);
      let operation = pending.get(batchKey);
      if (!operation) {
        if (jobs.size>=2) throw new Error('名称查询繁忙，请稍后重试');
        const python = pythonCommand();
        if (!python) throw new Error('未找到 Python，暂时无法查询名称');
        operation = runWorker(python, account, wanted).then(workerResults => {
          const resolved = new Map();
          for (const value of wanted) {
            const result = workerResults.find(result => result?.value === value);
            const safe = result?.status === 'ok' && typeof result.title === 'string' && typeof result.id === 'string' && /^-?\d+$/.test(result.id) && ['channel','group'].includes(result.type)
              ? {status:'ok', title:result.title.slice(0,200), id:result.id, type:result.type}
              : {status:'error', message:Object.hasOwn(lookupErrors,result?.code) ? lookupErrors[result.code] : result?.message === '此会话不是群组或频道' ? result.message : result?.message === '查询触发限流，请稍后重试' ? result.message : chatInputError};
            const entry = {result:safe, expires:Date.now()+(safe.status==='ok'?600000:30000)};
            cache.set(key(value), entry);
            resolved.set(value, entry);
          }
          while (cache.size>300) cache.delete(cache.keys().next().value);
          return resolved;
        }).finally(() => pending.delete(batchKey));
        pending.set(batchKey, operation);
      }
      for (const [value, entry] of await operation) results.set(value, entry);
    }
    return peers.map(value => ({value, ...(valid(value) ? results.get(value).result : {status:'error',message:chatInputError})}));
  }
  function runWorker(python, account, peers) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = spawnWorker(python.name, [...(python.prefix || []), '-u', path.join(root,'chat_lookup.py'), account, JSON.stringify(peers)], {
          cwd:root, env:{...process.env,...workerEnv,AUTOCHECKIN_DATA_DIR:dataDir,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe'],windowsHide:true
        });
      } catch { reject(new Error('无法启动名称查询')); return; }
      let output='', invalid=false, timedOut=false, killTimer, stoppingWorker=false, finish;
      const completion = new Promise(resolve => { finish=resolve; });
      function stop() {
        if (!stoppingWorker) {
          stoppingWorker=true;
          killTimer=setTimeout(()=>worker.kill('SIGKILL'),stopGraceMs);
          killTimer.unref?.();
          worker.kill();
        }
        return completion;
      }
      jobs.set(worker, stop);
      const timer=setTimeout(() => {timedOut=true;stop();},timeoutMs);
      timer.unref?.();
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data',chunk => {if(invalid)return;output+=chunk;if(output.length>100000){invalid=true;output='';stop();}});
      worker.stderr.resume();
      worker.on('error',()=>{invalid=true;});
      worker.on('close',code => {
        clearTimeout(timer);clearTimeout(killTimer);jobs.delete(worker);finish();
        if (closed) return reject(new Error('服务正在停止'));
        if (timedOut) return reject(new Error('名称查询超时，请稍后重试'));
        try {const data=JSON.parse(output);if(code || invalid || !Array.isArray(data.results))throw new Error();resolve(data.results);}
        catch {reject(new Error('无法查询名称，请检查登录状态和网络后重试'));}
      });
    });
  }
  function shutdown() {
    closed=true;
    stopping ||= Promise.all([...jobs.values()].map(stop => stop())).then(() => {});
    return stopping;
  }
  return {resolve,shutdown};
}
module.exports={createChatResolver};
