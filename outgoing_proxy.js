'use strict';
const net = require('node:net'), tls = require('node:tls');
const http = require('node:http'), https = require('node:https');
const proxyFailure = () => Error('出口代理连接失败，请检查代理配置、认证及网络');

function normalizeProxy(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') throw Error('代理配置格式不正确');
  const type = input.type || 'http', host = String(input.host || '').trim().replace(/^\[([^\]]+)\]$/, '$1');
  const port = input.port === '' || input.port == null ? '' : Number(input.port);
  const username = String(input.username || '');
  const password = input.clearPassword === true ? '' : input.password == null || input.password === '' ? previous.password || '' : String(input.password);
  if (!['http','https','socks5'].includes(type)) throw Error('代理类型仅支持 HTTP、HTTPS 或 SOCKS5');
  if (host && !(net.isIP(host) || /^(?=.{1,253}$)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?$/.test(host))) throw Error('代理地址请填写主机名或 IP，不包含协议、端口或路径');
  if (port !== '' && (!Number.isInteger(port) || port < 1 || port > 65535)) throw Error('代理端口范围为 1–65535');
  if (/[\r\n\0:]/.test(username) || /[\r\n\0]/.test(password) || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) throw Error('代理认证信息格式不正确或超过 255 字节');
  if (input.enabled && (!host || !port)) throw Error('启用代理时请完整填写地址和端口');
  if (input.enabled && password && !username) throw Error('配置代理密码时请同时填写用户名');
  return {enabled:input.enabled,type,host,port,username,password};
}
function proxyView(proxy = {}) {
  return {enabled:proxy.enabled === true,type:proxy.type || 'http',host:proxy.host || '',port:proxy.port || '',username:proxy.username || '',hasPassword:Boolean(proxy.password)};
}
async function readBytes(socket, length, signal) {
  while (true) {
    if (signal?.aborted || socket.destroyed || socket.readableEnded) throw proxyFailure();
    const bytes = socket.read(length);
    if (bytes) return bytes;
    await new Promise((resolve,reject) => {
      const clean = () => {socket.off('readable',ready);socket.off('error',fail);socket.off('end',fail);socket.off('close',fail);signal?.removeEventListener('abort',fail);};
      const ready = () => {clean();resolve();}, fail = () => {clean();reject(proxyFailure());};
      socket.once('readable',ready);socket.once('error',fail);socket.once('end',fail);socket.once('close',fail);signal?.addEventListener('abort',fail,{once:true});
    });
  }
}
async function openTunnel(proxy, host, port, signal) {
  let socket;
  const abort = () => socket?.destroy();
  try {
    if (signal?.aborted) throw proxyFailure();
    socket = proxy.type === 'https'
      ? tls.connect({host:proxy.host,port:proxy.port,servername:net.isIP(proxy.host) ? undefined : proxy.host,rejectUnauthorized:true})
      : net.connect({host:proxy.host,port:proxy.port});
    socket.on('error',()=>{});
    signal?.addEventListener('abort',abort,{once:true});
    await new Promise((resolve,reject) => {
      const event = proxy.type === 'https' ? 'secureConnect' : 'connect';
      const clean = () => {socket.off(event,ready);socket.off('error',fail);socket.off('close',fail);};
      const ready = () => {clean();resolve();}, fail = () => {clean();reject(proxyFailure());};
      socket.once(event,ready);socket.once('error',fail);socket.once('close',fail);
    });
    if (proxy.type === 'socks5') {
      socket.write(Buffer.from(proxy.username ? [5,1,2] : [5,1,0]));
      const greeting = await readBytes(socket,2,signal);
      if (greeting[0] !== 5 || greeting[1] !== (proxy.username ? 2 : 0)) throw proxyFailure();
      if (proxy.username) {
        const user=Buffer.from(proxy.username), password=Buffer.from(proxy.password || '');
        socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([password.length]),password]));
        const auth = await readBytes(socket,2,signal);
        if (auth[0] !== 1 || auth[1] !== 0) throw proxyFailure();
      }
      // Domain-form destinations are resolved by the proxy, never by local DNS.
      const domain=Buffer.from(host), destinationPort=Buffer.alloc(2);destinationPort.writeUInt16BE(port);
      if (!domain.length || domain.length > 255) throw proxyFailure();
      socket.write(Buffer.concat([Buffer.from([5,1,0,3,domain.length]),domain,destinationPort]));
      const reply=await readBytes(socket,4,signal);
      if (reply[0] !== 5 || reply[1] !== 0) throw proxyFailure();
      const length=reply[3]===1 ? 4 : reply[3]===4 ? 16 : reply[3]===3 ? (await readBytes(socket,1,signal))[0] : 0;
      if (!length) throw proxyFailure();
      await readBytes(socket,length+2,signal);
    } else {
      const destination=`${net.isIP(host)===6 ? '['+host+']' : host}:${port}`;
      const auth=proxy.username ? 'Proxy-Authorization: Basic '+Buffer.from(proxy.username+':'+(proxy.password || '')).toString('base64')+'\r\n' : '';
      socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n${auth}\r\n`);
      let header='';
      while (!header.endsWith('\r\n\r\n')) {
        if (header.length >= 32768) throw proxyFailure();
        header+=(await readBytes(socket,1,signal)).toString('latin1');
      }
      if (!/^HTTP\/1\.[01] 200(?:\s|\r)/.test(header)) throw proxyFailure();
    }
    return socket;
  } catch {socket?.destroy();throw proxyFailure();}
  finally {signal?.removeEventListener('abort',abort);}
}
function createProxyFetch(readProxy, {nativeFetch = globalThis.fetch} = {}) {
  const active = new Set();
  return {
    async fetch(url, options = {}) {
      if (url instanceof Request) {
        const request=url;
        options={method:request.method,headers:request.headers,signal:request.signal,...options};
        if (options.body===undefined && !['GET','HEAD'].includes(options.method)) options.body=Buffer.from(await request.arrayBuffer());
        url=request.url;
      }
      const controller=new AbortController();active.add(controller);
      const signal=options.signal ? AbortSignal.any([options.signal,controller.signal]) : controller.signal;
      const timer=setTimeout(()=>controller.abort(),15000);
      let agent;
      try {
        const stored=readProxy();
        if (!stored?.enabled) {
          const response=await nativeFetch(url,{...options,signal});
          const body=await response.arrayBuffer();
          return new Response([204,205,304].includes(response.status) ? null : body,{status:response.status,headers:response.headers});
        }
        const proxy=normalizeProxy(stored), target=new URL(url);
        if (!['http:','https:'].includes(target.protocol) || target.username || target.password) throw proxyFailure();
        const secure=target.protocol==='https:', host=target.hostname.replace(/^\[|\]$/g,''), port=Number(target.port || (secure ? 443 : 80));
        agent=secure ? new https.Agent({keepAlive:false}) : new http.Agent({keepAlive:false});
        agent.createConnection=(_options,callback)=>{
          void openTunnel(proxy,host,port,signal).then(socket=>{
            if (signal.aborted) {socket.destroy();callback(proxyFailure());return;}
            if (!secure) {callback(null,socket);return;}
            const connection=tls.connect({socket,host,servername:net.isIP(host) ? undefined : host,rejectUnauthorized:true});
            const abort=()=>connection.destroy();signal.addEventListener('abort',abort,{once:true});
            const cleanup=()=>{signal.removeEventListener('abort',abort);connection.off('secureConnect',ready);connection.off('error',fail);connection.off('close',fail);};
            const ready=()=>{cleanup();callback(null,connection);}, fail=()=>{cleanup();connection.destroy();callback(proxyFailure());};
            connection.once('secureConnect',ready);connection.once('error',fail);connection.once('close',fail);
          },()=>callback(proxyFailure()));
        };
        return await new Promise((resolve,reject)=>{
          const request=(secure ? https : http).request(target,{method:options.method || 'GET',headers:Object.fromEntries(new Headers(options.headers)),agent,signal},response=>{
            const chunks=[];let size=0;
            response.on('data',chunk=>{size+=chunk.length;if(size>1048576)request.destroy(proxyFailure());else chunks.push(chunk);});
            response.on('error',()=>reject(proxyFailure()));
            response.on('end',()=>{
              if (response.statusCode>=300 && response.statusCode<400) {reject(Error('出口请求不允许重定向'));return;}
              resolve(new Response([204,205,304].includes(response.statusCode) ? null : Buffer.concat(chunks),{status:response.statusCode,headers:response.headers}));
            });
          });
          request.on('error',()=>reject(proxyFailure()));
          request.end(options.body);
        });
      } finally {clearTimeout(timer);agent?.destroy();active.delete(controller);}
    },
    reset() {for (const controller of active) controller.abort();},
    close() {this.reset();}
  };
}
// Install once at server startup. HTTP clients share this policy even if a module
// forgets to request the explicit proxy fetch. Raw TCP clients cannot bypass it.
function installOutgoingNetwork(readProxy, {databaseEndpoints = []} = {}) {
  const network=createProxyFetch(readProxy);
  const originalFetch=globalThis.fetch, originalConnect=net.Socket.prototype.connect;
  const originalHttp=http.Agent.prototype.createConnection, originalHttps=https.Agent.prototype.createConnection;
  const sockets=new Set(), pending=new Set();
  const sameHost=(left,right)=>String(left).replace(/^\[|\]$/g,'').toLowerCase()===String(right).replace(/^\[|\]$/g,'').toLowerCase();
  net.Socket.prototype.connect=function(...args) {
    const first=Array.isArray(args[0]) ? args[0][0] : args[0];
    const options=typeof first==='object' ? first : {port:first,host:typeof args[1]==='string' ? args[1] : 'localhost'};
    const host=options.host || 'localhost', port=Number(options.port);
    const database=databaseEndpoints.some(item=>sameHost(item.host,host) && Number(item.port)===port);
    if (database) return originalConnect.apply(this,args);
    const stored=readProxy();
    if (stored?.enabled) {
      const proxy=normalizeProxy(stored);
      if (!(sameHost(proxy.host,host) && proxy.port===port)) throw Error('已启用系统出口代理，禁止绕过代理直接联网');
    }
    // Also track direct-mode sockets so enabling the proxy closes old clients.
    sockets.add(this);this.once('close',()=>sockets.delete(this));
    return originalConnect.apply(this,args);
  };
  function connectionFactory(secure, original) {
    return function(options, callback) {
      const stored=readProxy();
      if (!stored?.enabled) return original.call(this,options,callback);
      const controller=new AbortController();pending.add(controller);
      const timer=setTimeout(()=>controller.abort(),15000);
      const host=String(options.hostname || options.host || 'localhost').replace(/^\[|\]$/g,''), port=Number(options.port || (secure ? 443 : 80));
      const finish=(error,socket)=>{clearTimeout(timer);pending.delete(controller);callback(error,socket);};
      void openTunnel(normalizeProxy(stored),host,port,controller.signal).then(socket=>{
        if (!secure) return finish(null,socket);
        const stream=tls.connect({...options,socket,host,servername:options.servername || (net.isIP(host) ? undefined : host),rejectUnauthorized:true});
        const abort=()=>stream.destroy();controller.signal.addEventListener('abort',abort,{once:true});
        const clean=()=>{controller.signal.removeEventListener('abort',abort);stream.off('secureConnect',ready);stream.off('error',fail);stream.off('close',fail);};
        const ready=()=>{clean();finish(null,stream);}, fail=()=>{clean();stream.destroy();finish(proxyFailure());};
        stream.once('secureConnect',ready);stream.once('error',fail);stream.once('close',fail);
      },()=>finish(proxyFailure()));
    };
  }
  http.Agent.prototype.createConnection=connectionFactory(false,originalHttp);
  https.Agent.prototype.createConnection=connectionFactory(true,originalHttps);
  globalThis.fetch=network.fetch;
  // Existing agents must not reuse a connection opened before the policy changed.
  const reset=network.reset.bind(network);
  network.reset=()=>{reset();for(const controller of pending)controller.abort();for(const socket of sockets)socket.destroy();http.globalAgent.destroy();https.globalAgent.destroy();};
  network.close=()=>{
    network.reset();globalThis.fetch=originalFetch;
    net.Socket.prototype.connect=originalConnect;
    http.Agent.prototype.createConnection=originalHttp;https.Agent.prototype.createConnection=originalHttps;
  };
  return network;
}
module.exports={normalizeProxy,proxyView,openTunnel,createProxyFetch,installOutgoingNetwork};
