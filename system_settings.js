'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {normalizeProxy,proxyView} = require('./outgoing_proxy');

function applySystemConfig(config, settings = {}) {
  const result = structuredClone(config);
  if (settings.automatic || settings.overrides?.telegram || config.telegram?.use_system === true) {
    result.telegram = {...result.telegram, api_id:settings.telegram?.api_id || '', api_hash:settings.telegram?.api_hash || ''};
  }
  if (settings.automatic || settings.overrides?.ai || config.ai?.use_system === true) {
    result.ai = {...structuredClone(settings.ai || {providers:[]}), use_system:true};
    const selected=config.ai?.use_system === false ? '' : config.ai?.system_provider_id;
    if (selected) result.ai.providers=(settings.available_providers || result.ai.providers).filter(item=>item.id===selected);
  }
  return result;
}
function mergeSettings(admin, own, automatic=true) {
  const sources={telegram:own.telegram?.api_id && own.telegram?.api_hash ? 'personal' : 'admin',ai:own.ai?.providers?.length ? 'personal' : 'admin',proxy:own.default_proxy_id ? 'personal' : 'admin'};
  return {...structuredClone(admin),automatic,sources,overrides:{telegram:sources.telegram==='personal' || own.use_globals===true,ai:sources.ai==='personal' || own.use_globals===true},
    telegram:structuredClone((sources.telegram==='personal' ? own : admin).telegram || {}),
    ai:structuredClone((sources.ai==='personal' ? own : admin).ai || {providers:[]}),
    available_providers:[...(own.ai?.providers || []).map(p=>({...p,model:p.model || own.ai.model || '',source:'personal'})),...(admin.ai?.providers || []).map(p=>({...p,model:p.model || admin.ai.model || '',source:'admin'}))],
    proxies:[...(own.proxies || []).map(p=>({...p,source:'personal'})),...(admin.proxies || []).map(p=>({...p,source:'admin'}))],
    default_proxy_id:(sources.proxy==='personal' ? own : admin).default_proxy_id || '',
    proxy:structuredClone((sources.proxy==='personal' ? own : admin).proxy || {enabled:false})};
}
function settingsView(settings) {
  return {automatic:Boolean(settings.automatic),sources:settings.sources,overrides:settings.overrides,
    telegram:{apiId:settings.telegram?.api_id || '',hasApiHash:Boolean(settings.telegram?.api_hash)},model:settings.ai?.model || '',
    providers:(settings.available_providers || settings.ai?.providers || []).map((p,index)=>({id:p.id,sourceIndex:index,name:p.name,model:p.model || '',baseUrl:p.base_url,hasApiKey:Boolean(p.api_key),source:p.source})),
    activeProviderIds:(settings.ai?.providers || []).map(p=>p.id),
    proxies:(settings.proxies || []).map(p=>({id:p.id,name:p.name,type:p.type,source:p.source})),defaultProxyId:settings.default_proxy_id || ''};
}
function secretValues(settings) {
  return [settings.telegram?.api_hash,...(settings.ai?.providers || []).map(p=>p.api_key),...(settings.proxies || []).map(p=>p.password)].filter(value=>typeof value==='string' && value);
}
async function createPersonalSettings({dataDir,store,admin,legacy={},documentKey='system-settings',fileName='.system-settings.json',automatic=true}) {
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const file=path.join(dataDir,fileName);
  const saved=store ? store.read(documentKey) : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : null;
  if (!saved?.legacy_services_migrated) {
    // Import missing categories once, including administrators with an older empty
    // personal document. An explicitly cleared category must continue to inherit.
    const initial=structuredClone(saved || {});
    if (!Object.hasOwn(initial,'telegram') && legacy.telegram?.use_system!==true && legacy.telegram?.api_id && legacy.telegram?.api_hash) initial.telegram={api_id:legacy.telegram.api_id,api_hash:legacy.telegram.api_hash};
    if (!Object.hasOwn(initial,'ai') && legacy.ai?.use_system!==true) {
      const providers=legacy.ai?.providers || (legacy.ai?.api_key ? [{name:'default',base_url:legacy.ai.base_url,api_key:legacy.ai.api_key}] : []);
      if (providers.length) initial.ai={...legacy.ai,providers:providers.map(p=>({...p,id:p.id || randomUUID()}))};
    }
    initial.legacy_services_migrated=true;
    initial.use_globals=true;
    if (store) await store.write(documentKey,initial);
    else {fs.writeFileSync(file+'.tmp',JSON.stringify(initial),{mode:0o600});fs.renameSync(file+'.tmp',file);}
  }
  const own=await createSystemSettings({dataDir,store,documentKey,fileName});
  const effective={read:()=>mergeSettings(admin.read(),own.read(),automatic),view:()=>settingsView(mergeSettings(admin.read(),own.read(),automatic)),secretValues:()=>[...secretValues(admin.read()),...secretValues(own.read())]};
  return {own,effective};
}
async function createSystemSettings({dataDir, store,documentKey='system-settings',fileName='.system-settings.json'}) {
  const file = path.join(dataDir,fileName);
  let settings = structuredClone(store ? store.read(documentKey) || {} : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {});
  // Stable IDs preserve references across reordering and migrate the single proxy.
  settings.proxies ||= settings.proxy?.host ? [{...settings.proxy,enabled:true,id:'legacy-proxy',name:'原系统代理'}] : [];
  settings.default_proxy_id ??= settings.proxy?.enabled ? 'legacy-proxy' : '';
  if (settings.ai?.providers) settings.ai.providers=settings.ai.providers.map((item,index)=>({...item,id:item.id || `legacy-ai-${index}`}));
  let queue = Promise.resolve();
  function view() {
    return {telegram:{apiId:settings.telegram?.api_id || '', hasApiHash:Boolean(settings.telegram?.api_hash)}, model:settings.ai?.model || '', providers:(settings.ai?.providers || []).map((item,index)=>({id:item.id,sourceIndex:index,name:item.name,model:item.model || '',baseUrl:item.base_url,hasApiKey:Boolean(item.api_key)})),proxies:settings.proxies.map(item=>({id:item.id,name:item.name,type:item.type})),defaultProxyId:settings.default_proxy_id};
  }
  function update(input) {
    const pending = queue.then(async()=>{
      const updateTelegram=input && Object.hasOwn(input,'telegram'),updateAI=input && Object.hasOwn(input,'providers');
      if (!input || typeof input!=='object' || Array.isArray(input) || !updateTelegram && !updateAI || updateTelegram && (!input.telegram || typeof input.telegram!=='object' || Array.isArray(input.telegram)) || updateAI && (!Array.isArray(input.providers) || input.providers.length>20)) throw Error('系统配置格式不正确');
      const rawId = String(updateTelegram ? input.telegram.apiId || '' : settings.telegram?.api_id || '').trim();
      const hash = updateTelegram ? (input.telegram.clear === true ? '' : String(input.telegram.apiHash || '').trim() || settings.telegram?.api_hash || '') : settings.telegram?.api_hash || '';
      if (updateTelegram && rawId && (!/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0)) throw Error('系统 API ID 无效');
      if (updateTelegram && Boolean(rawId) !== Boolean(hash)) throw Error('请完整填写系统 API ID 和 API Hash');
      const providers = updateAI ? input.providers.map(item=>{
        const name = String(item.name || '').trim(), base_url = String(item.baseUrl || '').trim();
        const old=item.id ? settings.ai?.providers?.find(p=>p.id===item.id) : settings.ai?.providers?.[item.sourceIndex];
        const api_key = String(item.apiKey || '').trim() || old?.api_key;
        if (!name || name.length > 80 || base_url.length > 500 || !/^https?:\/\//i.test(base_url) || !api_key || api_key.length > 4096) throw Error('请完整填写 AI 提供商名称、HTTP 地址和 API Key');
        const providerModel=String(item.model || '').trim();
        if (providerModel.length>120) throw Error('AI 模型过长');
        return {id:old?.id || randomUUID(),name,base_url,api_key,model:providerModel};
      }) : structuredClone(settings.ai?.providers || []);
      if (updateAI && new Set(providers.map(item=>item.id)).size!==providers.length) throw Error('AI 提供商不能重复引用');
      const model = String(updateAI ? input.model ?? settings.ai?.model ?? '' : settings.ai?.model || '').trim();
      if (updateAI && ((providers.some(p=>!p.model) && !model) || model.length>120) || updateTelegram && hash.length>4096) throw Error('AI 模型或 API Hash 格式不正确');
      const next = {...settings,...(documentKey==='personal-settings' ? {use_globals:true} : {}),...(updateTelegram ? {telegram:{api_id:rawId ? Number(rawId) : '',api_hash:hash}} : {}),...(updateAI ? {ai:{model,providers}} : {})};
      if (store) await store.write(documentKey,next);
      else { fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file); }
      settings = next;
      return view();
    });
    queue = pending.catch(()=>{});
    return pending;
  }
  function updateProxy(input) {
    const pending=queue.then(async()=>{
      const proxy=normalizeProxy(input,settings.proxy);
      const id=settings.default_proxy_id || 'legacy-proxy';
      const entry={...proxy,enabled:true,id,name:settings.proxies.find(p=>p.id===id)?.name || '原系统代理'};
      const next={...settings,proxy,proxies:[...settings.proxies.filter(p=>p.id!==id),entry],default_proxy_id:proxy.enabled ? id : ''};
      if (store) await store.write(documentKey,next);
      else {fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);}
      settings=next;
      return proxyView(settings.proxy);
    });
    queue=pending.catch(()=>{});return pending;
  }
  function changeProxies(input) {
    const pending=queue.then(async()=>{
      if (!Array.isArray(input.proxies) || input.proxies.length>50) throw Error('最多配置 50 条代理');
      const ids=new Set();
      const proxies=input.proxies.map(item=>{
        const old=settings.proxies.find(p=>p.id===item.id);
        const id=old?.id || randomUUID(), name=String(item.name || '').trim();
        if (!name || name.length>80 || ids.has(id)) throw Error('代理名称不能为空、超过 80 字或重复引用');
        ids.add(id);
        return {...normalizeProxy({...item,enabled:true},old),id,name};
      });
      const defaultId=input.defaultProxyId || '';
      if (defaultId && !ids.has(defaultId)) throw Error('默认出口代理不存在');
      const next={...settings,proxies,default_proxy_id:defaultId,proxy:proxies.find(p=>p.id===defaultId) || {enabled:false}};
      if (store) await store.write(documentKey,next);
      else {fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);}
      settings=next;return proxyList();
    });
    queue=pending.catch(()=>{});return pending;
  }
  function proxyList() {return {proxies:settings.proxies.map(p=>({...proxyView(p),id:p.id,name:p.name})),defaultProxyId:settings.default_proxy_id};}
  return {read:()=>structuredClone(settings),view,update,updateProxy,changeProxies,proxyList,proxyView:()=>proxyView(settings.proxy),secretValues:()=>secretValues(settings)};
}
module.exports = {createSystemSettings,createPersonalSettings,mergeSettings,settingsView,applySystemConfig};
