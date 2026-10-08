'use strict';
const fs = require('node:fs');
const path = require('node:path');

function applySystemConfig(config, settings = {}) {
  const result = structuredClone(config);
  if (config.telegram?.use_system === true) {
    result.telegram = {...result.telegram, api_id:settings.telegram?.api_id || '', api_hash:settings.telegram?.api_hash || ''};
  }
  if (config.ai?.use_system === true) result.ai = {...structuredClone(settings.ai || {providers:[]}), use_system:true};
  return result;
}
async function createSystemSettings({dataDir, store}) {
  const file = path.join(dataDir,'.system-settings.json');
  let settings = structuredClone(store ? store.read('system-settings') || {} : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {});
  let queue = Promise.resolve();
  function view() {
    return {telegram:{apiId:settings.telegram?.api_id || '', hasApiHash:Boolean(settings.telegram?.api_hash)}, model:settings.ai?.model || '', providers:(settings.ai?.providers || []).map((item,index)=>({sourceIndex:index,name:item.name,baseUrl:item.base_url,hasApiKey:Boolean(item.api_key)}))};
  }
  function update(input) {
    const pending = queue.then(async()=>{
      if (!input || !input.telegram || typeof input.telegram !== 'object' || Array.isArray(input.telegram) || !Array.isArray(input.providers) || input.providers.length > 20) throw Error('系统配置格式不正确');
      const rawId = String(input.telegram.apiId || '').trim();
      const hash = String(input.telegram.apiHash || '').trim() || settings.telegram?.api_hash || '';
      if (rawId && (!/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0)) throw Error('系统 API ID 无效');
      if (Boolean(rawId) !== Boolean(hash)) throw Error('请完整填写系统 API ID 和 API Hash');
      const providers = input.providers.map(item=>{
        const name = String(item.name || '').trim(), base_url = String(item.baseUrl || '').trim();
        const api_key = String(item.apiKey || '').trim() || settings.ai?.providers?.[item.sourceIndex]?.api_key;
        if (!name || name.length > 80 || base_url.length > 500 || !/^https?:\/\//i.test(base_url) || !api_key || api_key.length > 4096) throw Error('请完整填写 AI 提供商名称、HTTP 地址和 API Key');
        return {name,base_url,api_key};
      });
      const model = String(input.model || '').trim();
      if ((providers.length && !model) || model.length > 120 || hash.length > 4096) throw Error('AI 模型或 API Hash 格式不正确');
      const next = {telegram:{api_id:rawId ? Number(rawId) : '',api_hash:hash},ai:{model,providers}};
      if (store) await store.write('system-settings',next);
      else { fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file); }
      settings = next;
      return view();
    });
    queue = pending.catch(()=>{});
    return pending;
  }
  return {read:()=>structuredClone(settings),view,update};
}
module.exports = {createSystemSettings,applySystemConfig};
