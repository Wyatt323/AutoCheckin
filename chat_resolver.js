const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCredentials } = require('./telegram_credentials');

function createChatResolver({root, dataDir, readConfig, pythonCommand, spawnWorker=spawn, timeoutMs=45000}) {
  const cache = new Map(), pending = new Map(), jobs = new Set();
  let closed = false;
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
    const wanted = [...new Set(peers)].filter(value => valid(value) && (cache.get(key(value))?.expires || 0) < Date.now());
    if (wanted.length) {
      const batchKey = JSON.stringify([account, stamp, wanted.slice().sort()]);
      let operation = pending.get(batchKey);
      if (!operation) {
        if (jobs.size>=2) throw new Error('名称查询繁忙，请稍后重试');
        const python = pythonCommand();
        if (!python) throw new Error('未找到 Python，暂时无法查询名称');
        operation = runWorker(python, account, wanted).then(results => {
          for (const value of wanted) {
            const result = results.find(result => result?.value === value);
            const safe = result?.status === 'ok' && typeof result.title === 'string' && typeof result.id === 'string' && /^-?\d+$/.test(result.id) && ['channel','group'].includes(result.type)
              ? {status:'ok', title:result.title.slice(0,200), id:result.id, type:result.type}
              : {status:'error', message:result?.message === '此会话不是群组或频道' ? result.message : result?.message === '查询触发限流，请稍后重试' ? result.message : '无法获取，请检查 ID、用户名及账号权限'};
            cache.set(key(value), {result:safe, expires:Date.now()+(safe.status==='ok'?600000:30000)});
          }
          while (cache.size>300) cache.delete(cache.keys().next().value);
        }).finally(() => pending.delete(batchKey));
        pending.set(batchKey, operation);
      }
      await operation;
    }
    return peers.map(value => ({value, ...(valid(value) ? cache.get(key(value)).result : {status:'error',message:'请填写有效的 ID、用户名或公开 t.me 链接'})}));
  }
  function runWorker(python, account, peers) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = spawnWorker(python.name, [...(python.prefix || []), '-u', path.join(root,'chat_lookup.py'), account, JSON.stringify(peers)], {
          cwd:root, env:{...process.env,AUTOCHECKIN_DATA_DIR:dataDir,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe'],windowsHide:true
        });
      } catch { reject(new Error('无法启动名称查询')); return; }
      jobs.add(worker);
      let output='', invalid=false, timedOut=false, killTimer;
      const timer=setTimeout(() => {timedOut=true;worker.kill();killTimer=setTimeout(()=>worker.kill('SIGKILL'),2000);killTimer.unref?.();},timeoutMs);
      timer.unref?.();
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data',chunk => {output+=chunk;if(output.length>100000){invalid=true;output='';worker.kill();}});
      worker.stderr.resume();
      worker.on('error',()=>{invalid=true;});
      worker.on('close',code => {
        clearTimeout(timer);clearTimeout(killTimer);jobs.delete(worker);
        if (timedOut) return reject(new Error('名称查询超时，请稍后重试'));
        try {const data=JSON.parse(output);if(code || invalid || !Array.isArray(data.results))throw new Error();resolve(data.results);}
        catch {reject(new Error('无法查询名称，请检查登录状态和网络后重试'));}
      });
    });
  }
  async function shutdown() {
    closed=true;
    const workers=[...jobs];
    await Promise.all(workers.map(worker=>new Promise(resolve=>{worker.once('close',resolve);worker.kill();})));
  }
  return {resolve,shutdown};
}
module.exports={createChatResolver};
