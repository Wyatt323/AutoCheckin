// Local synthetic proxies only. The fixture key is public test material, never a deployment key.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const net=require('node:net'),tls=require('node:tls'),{spawnSync}=require('node:child_process');
const cert=path.join(__dirname,'fixtures/proxy-test-cert.pem');
if (!process.env.AUTOCHECKIN_PROXY_TEST_CA) {
  const child=spawnSync(process.execPath,[__filename],{env:{...process.env,AUTOCHECKIN_PROXY_TEST_CA:'1',NODE_EXTRA_CA_CERTS:cert},stdio:'inherit'});
  process.exit(child.status ?? 1);
}
const {normalizeProxy,createProxyFetch,installOutgoingNetwork}=require('../outgoing_proxy');
const key=fs.readFileSync(path.join(__dirname,'fixtures/proxy-test-key.pem')),certificate=fs.readFileSync(cert);
const context=tls.createSecureContext({key,cert:certificate});
(async()=>{
  const servers=[],sockets=new Set(),connections=[];
  async function proxy(type,{reject=false,secureTarget=false,authenticated=true}={}) {
    const handler=socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
      let buffer=Buffer.alloc(0),phase=type==='socks5' ? 'greeting' : 'connect';
      function response(connection) {
        let request='';connection.on('data',chunk=>{request+=chunk.toString();if(request.includes('\r\n\r\n'))connection.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}');});
        connection.on('error',()=>{});
      }
      function ready() {
        socket.removeListener('data',data);
        if (secureTarget) response(new tls.TLSSocket(socket,{isServer:true,secureContext:context}));else response(socket);
      }
      function data(chunk) {
        buffer=Buffer.concat([buffer,chunk]);
        if (phase==='connect' && buffer.includes('\r\n\r\n')) {
          const header=buffer.toString();connections.push({type,header});
          if (reject) {socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n',ready);phase='done';return;
        }
        if (phase==='greeting' && buffer.length>=3) {
          assert.deepEqual([...buffer],[5,1,authenticated ? 2 : 0]);socket.write(Buffer.from([5,authenticated ? 2 : 0]));buffer=Buffer.alloc(0);phase=authenticated ? 'auth' : 'destination';return;
        }
        if (phase==='auth' && buffer.length>=2 && buffer.length>=3+buffer[1]+(buffer[2+buffer[1]] || 0)) {
          const length=buffer[1],user=buffer.subarray(2,2+length).toString(),secret=buffer.subarray(3+length).toString();
          assert.equal(user,'user');assert.equal(secret,'p@ss word');socket.write(Buffer.from([1,reject ? 1 : 0]));buffer=Buffer.alloc(0);phase='destination';return;
        }
        if (phase==='destination' && buffer.length>=5 && buffer.length>=7+buffer[4]) {
          assert.equal(buffer[3],3,'SOCKS5 sends domain to proxy instead of resolving it locally');
          connections.push({type,host:buffer.subarray(5,5+buffer[4]).toString(),port:buffer.readUInt16BE(5+buffer[4])});
          socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]),ready);phase='done';
        }
      }
      socket.on('data',data);
    };
    const server=type==='https' ? tls.createServer({key,cert:certificate},handler) : net.createServer(handler);
    server.on('tlsClientError',()=>{});servers.push(server);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {enabled:true,type,host:'127.0.0.1',port:server.address().port,username:authenticated ? 'user' : '',password:authenticated ? 'p@ss word' : ''};
  }
  let current, directCalls=0;
  const network=createProxyFetch(()=>current,{nativeFetch:async()=>{directCalls++;return new Response('{}');}});
  try {
    for (const type of ['http','https','socks5']) {
      current=await proxy(type);
      assert.deepEqual(await(await network.fetch('http://no-local-dns.invalid/test',{method:'POST',body:'hello'})).json(),{ok:true});
      if(type!=='socks5')assert.ok(connections.at(-1).header.includes('Proxy-Authorization: Basic '+Buffer.from('user:p@ss word').toString('base64')));
      else assert.equal(connections.at(-1).host,'no-local-dns.invalid');
    }
    current=await proxy('https',{secureTarget:true});
    assert.deepEqual(await(await network.fetch('https://localhost:443/test')).json(),{ok:true},'HTTPS proxy also supports TLS inside the CONNECT tunnel');
    current=await proxy('https',{secureTarget:true});await assert.rejects(network.fetch('https://wrong-host.invalid/test'),/出口代理连接失败/,'TLS destination certificates must be verified');
    for(const type of ['http','socks5']) {
      current=await proxy(type,{authenticated:false});
      assert.deepEqual(await(await network.fetch('http://no-local-dns.invalid/test')).json(),{ok:true});
    }
    for (const type of ['http','socks5']) {
      current=await proxy(type,{reject:true});
      await assert.rejects(network.fetch('https://no-local-dns.invalid'),/出口代理连接失败/);
    }
    assert.equal(directCalls,0,'proxy failures never fall back to direct fetch');
    current={enabled:false};await network.fetch('https://example.invalid');assert.equal(directCalls,1);
    const saved=normalizeProxy({enabled:true,type:'socks5',host:'[::1]',port:'1080',username:'user',password:'secret'});
    assert.equal(saved.host,'::1');assert.equal(normalizeProxy({...saved,password:''},saved).password,'secret');
    assert.equal(normalizeProxy({...saved,clearPassword:true},saved).password,'');
    for(const change of [{type:'socks4'},{host:'http://proxy/path'},{port:0},{port:65536},{username:'bad\r\nHost:x'}])assert.throws(()=>normalizeProxy({...saved,...change}));
    const http=require('node:http'),https=require('node:https');
    const fetchBefore=globalThis.fetch;
    const database=await proxy('http',{authenticated:false});let changing=false;
    const globalNetwork=installOutgoingNetwork(()=>{if(changing)throw Error('proxy changing');return current;},{databaseEndpoints:[{host:database.host,port:database.port}]});
    const get=(transport,url,options={})=>new Promise((resolve,reject)=>{
      const request=transport.get(url,options,response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve(JSON.parse(body)));response.on('error',reject);});request.on('error',reject);
    });
    try {
      for(const type of ['http','https','socks5']) {
        current=await proxy(type);
        assert.deepEqual(await(await fetch('http://unconfigured-client.invalid')).json(),{ok:true});
        assert.deepEqual(await(await fetch(new Request('http://unconfigured-client.invalid',{method:'POST',body:'request-body'}))).json(),{ok:true});
        assert.deepEqual(await get(http,'http://unconfigured-client.invalid'),{ok:true});
        assert.deepEqual(await get(http,'http://unconfigured-client.invalid',{agent:false}),{ok:true});
        assert.deepEqual(await get(http,'http://unconfigured-client.invalid',{agent:new http.Agent()}),{ok:true});
      }
      current=await proxy('https',{secureTarget:true});
      assert.deepEqual(await get(https,'https://localhost'),{ok:true});
      changing=true;
      const persistence=net.connect({host:database.host,port:database.port});
      await new Promise((resolve,reject)=>{persistence.once('connect',resolve);persistence.once('error',reject);});persistence.destroy();
      changing=false;
      assert.throws(()=>net.connect({host:'127.0.0.1',port:1}),/禁止绕过代理/);
      assert.throws(()=>tls.connect({host:'bypass.invalid',port:443}),/禁止绕过代理/);
      current=await proxy('http',{reject:true});
      await assert.rejects(get(http,'http://unconfigured-client.invalid'),/出口代理连接失败/);
      current={enabled:false};
      const local=await proxy('http',{authenticated:false});
      const direct=net.connect({host:local.host,port:local.port});
      await new Promise((resolve,reject)=>{direct.once('connect',resolve);direct.once('error',reject);});direct.destroy();
    } finally {globalNetwork.close();}
    assert.equal(globalThis.fetch,fetchBefore);
    console.log('Outbound proxy PASS: HTTP/HTTPS/SOCKS5, auth, remote DNS, nested TLS, validation, disabled direct mode and no direct fallback');
  } finally {
    network.close();for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
