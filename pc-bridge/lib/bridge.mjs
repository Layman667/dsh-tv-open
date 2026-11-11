import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { VoiceHub } from './voice.mjs';
import { AvatarHub,envelope } from './avatar.mjs';

export function truncateUtf8(text, maxBytes) {
  let out='', bytes=0;
  for (const glyph of String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim()) {
    const n=Buffer.byteLength(glyph);
    if (bytes+n > maxBytes) break;
    bytes+=n; out+=glyph;
  }
  return out;
}

function emotion(text) {
  if (/难过|伤心|抱抱|对不起/.test(text)) return 'sad';
  if (/不明白|没听懂|困惑|什么意思/.test(text)) return 'confused';
  if (/开心|哈哈|嘿嘿|太好|喜欢|耶|好呀/.test(text)) return 'happy';
  return 'idle';
}

export function packetFor(message, config) {
  const text=truncateUtf8(message.text, config.display.maxTextBytes);
  return { type: message.role==='assistant' ? 'chat.reply' : 'chat.user', text,
    emotion: message.role==='assistant' ? emotion(text) : 'listening' };
}

function tokenOk(actual, expected) {
  if (typeof actual!=='string') return false;
  const a=Buffer.from(actual), b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
}

export async function startBridge(config, { demo=false,audioDemo=false,log=console.log,readVisual,voiceProviders } = {}) {
  let latest=null, forwarded=0, lastReplyAt=null, stopped=false;
  const server=http.createServer((req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    // This endpoint deliberately contains no chat, QQ IDs, paths or credentials.
    if(req.method==='GET' && req.url==='/health') res.end(JSON.stringify({ ok:true, mode:audioDemo?'audio-demo':demo?'demo':'chat', devices:wss.clients.size,forwarded,lastReplyAt,voiceEnabled:voice.enabled,voiceBusy:Boolean(voice.active) }));
    else { res.statusCode=404; res.end('{"ok":false}'); }
  });
  const wss=new WebSocketServer({ noServer:true, maxPayload:2048, perMessageDeflate:false });
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>{});
    const reject=(code,label)=>{socket.end(`HTTP/1.1 ${code} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
    if(req.url!==config.wsPath) return reject(404,'Not Found');
    // ArduinoWebsockets 0.5.4 adds this Origin by default. Ordinary web pages are rejected.
    const origin=req.headers.origin;
    if(origin && origin!=='https://github.com/gilmaimon/TinyWebsockets') return reject(403,'Forbidden');
    if(!tokenOk(req.headers['x-pair-token'],config.pairToken)) return reject(401,'Unauthorized');
    if(wss.clients.size>=8) return reject(503,'Service Unavailable');
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  function send(ws, packet) {
    if(ws.readyState!==WebSocket.OPEN) return;
    if(ws.bufferedAmount>65536) { ws.terminate(); return; }
    ws.send(JSON.stringify(packet),error=>{if(error) ws.terminate();});
  }
  function broadcast(message) {
    const packet=packetFor(message,config);
    if(message.role==='assistant') latest={...message,at:Date.now()};
    avatar.observe(packet);
    if(!packet.text) return;
    for(const ws of wss.clients) send(ws,packet);
    forwarded++;
    if(message.role==='assistant') lastReplyAt=new Date().toISOString();
    log(`[同步] ${message.role==='assistant'?'DSH 回复':'用户消息'}；${Buffer.byteLength(packet.text)} 字节；设备 ${wss.clients.size} 台`);
  }
  const binary=(ws,bytes)=>{
    if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<65536)ws.send(bytes,{binary:true},error=>{if(error)ws.terminate();});
    else ws.terminate();
  };
  const avatar=new AvatarHub(config,{send,sendBinary:binary,readVisual,log});
  await avatar.init();
  const voice=new VoiceHub(config,{send:(ws,p)=>{avatar.observe(p);send(ws,p);},sendBinary:(ws,bytes)=>binary(ws,ws.binaryEnvelope?envelope(2,bytes):bytes),log,audioDemo,providers:voiceProviders});
  try{if(!demo||audioDemo)await voice.init();else voice.enabled=false;}catch(error){await avatar.stop();wss.close();throw error;}
  wss.on('connection',ws=>{
    ws.alive=true;
    ws.on('error',()=>{});
    ws.on('pong',()=>{ws.alive=true;});
    ws.on('message',(data,binary)=>{
      if(binary){voice.handleBinary(ws,data);return;}
      let value;
      try {value=JSON.parse(data.toString());} catch {return ws.close(1007,'Invalid JSON');}
      if(value?.type==='device.status') {ws.alive=true;if(value.avatarVersion===1&&value.binaryEnvelope===1){ws.binaryEnvelope=true;avatar.attach(ws);}if(value.voiceVersion===2){ws.supportsVoice=true;voice.announce(ws);}}
      else if(!avatar.handleJson(ws,value)) voice.handleJson(ws,value);
    });
    ws.on('close',()=>{avatar.detach(ws);voice.detach(ws);log(`[设备] 当前连接 ${wss.clients.size} 台`);});
    log(`[设备] 已连接；当前 ${wss.clients.size} 台`);
    if(demo) send(ws,{type:'chat.reply',text:audioDemo?'按键录一段，松开听回放测试':'桥接测试：电脑已经连上啦！',emotion:'happy'});
    else if(config.display.replayLatestOnConnect && latest && Date.now()-latest.at<=config.display.maxReplayAgeMinutes*60000) send(ws,packetFor(latest,config));
  });
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.listenHost,()=>{server.off('error',reject);resolve();});});
  } catch(error) {await avatar.stop();await voice.stop();wss.close();throw error;}
  server.on('error',()=>log('[网络] 监听服务异常，请停止后检查端口与电脑 IP'));
  const heartbeat=setInterval(()=>{
    for(const ws of wss.clients) {
      if(!ws.alive) {ws.terminate();continue;}
      ws.alive=false;ws.ping();
    }
  },30000);
  let demoTimer;
  if(demo) demoTimer=setInterval(()=>broadcast({role:'assistant',text:'桥接演示中，真实 QQ 同步请用正常模式启动。',at:Date.now()}),8000);
  return { server,wss,voice,avatar,broadcast,address:server.address(),async stop(){
    if(stopped)return;stopped=true;
    clearInterval(heartbeat);clearInterval(demoTimer);
    await voice.stop();
    await avatar.stop();
    for(const ws of wss.clients)ws.terminate();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }};
}
