import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { gzipSync,gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket,WebSocketServer } from 'ws';
import { deviceConfig } from '../../app/config.mjs';
import { recognizePcm,synthesizePcm,parseAsrFrame,readVoiceKeys,ASR_URL,TTS_URL } from '../lib/doubao.mjs';
import { startBridge } from '../lib/bridge.mjs';

const KEYS={asr:'ASR_TEST_KEY_ONLY',tts:'TTS_TEST_KEY_ONLY'};
function config(){return deviceConfig({device:{host:'127.0.0.1',port:0,token:'a'.repeat(64)},voice:{enabled:true,secretsFile:'voice.secrets.json'}});}
async function until(fn,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(10);}assert.fail('Timed out');}

test('ASR sends official gzip SAUC packets and waits for final response',async t=>{
  const cloud=new WebSocketServer({host:'127.0.0.1',port:0});await once(cloud,'listening');
  t.after(()=>new Promise(r=>{for(const s of cloud.clients)s.terminate();cloud.close(r);}));
  let full=null,all=[];
  cloud.on('connection',(socket,req)=>{
    assert.equal(req.headers['x-api-key'],KEYS.asr);assert.equal(req.headers['x-api-resource-id'],'volc.seedasr.sauc.duration');
    socket.on('message',buffer=>{
      const type=buffer[1]>>4,flags=buffer[1]&15;
      assert.equal(buffer[0],0x11);assert.equal(buffer.readUInt32BE(4),buffer.length-8);
      if(type===1){assert.equal(buffer[2],0x11);full=JSON.parse(gunzipSync(buffer.subarray(8)));}
      else{assert.equal(type,2);all.push(gunzipSync(buffer.subarray(8)));}
      if(flags&2){
        const payload=gzipSync(Buffer.from(JSON.stringify({code:20000000,result:{text:'还记得我们之前聊的吗？'}})));
        const header=Buffer.alloc(12);header.set([0x11,0x93,0x11,0]);header.writeInt32BE(-3,4);header.writeUInt32BE(payload.length,8);
        socket.send(Buffer.concat([header,payload]));
      }
    });
  });
  const pcm=Buffer.alloc(12800,0x12);
  const text=await recognizePcm(pcm,config(),KEYS,new AbortController().signal,{paceMs:0,wsFactory:(url,opts)=>{assert.equal(url,ASR_URL);return new WebSocket(`ws://127.0.0.1:${cloud.address().port}`,opts);}});
  assert.equal(text,'还记得我们之前聊的吗？');assert.deepEqual(Buffer.concat(all),pcm);
  assert.deepEqual(full.audio,{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1});
});

test('ASR parser rejects malformed packets and ASR cancellation stops the connection',async t=>{
  assert.throws(()=>parseAsrFrame(Buffer.from([0x11,0x93,0x11,0])));
  const err=Buffer.alloc(10);err.set([0x11,0xf0,0x10,0]);err.writeUInt32BE(45000001,4);err.writeUInt16BE(0,8);
  assert.throws(()=>parseAsrFrame(err));
  const cloud=new WebSocketServer({host:'127.0.0.1',port:0});await once(cloud,'listening');
  t.after(()=>new Promise(r=>{for(const s of cloud.clients)s.terminate();cloud.close(r);}));
  const controller=new AbortController();
  const promise=recognizePcm(Buffer.alloc(32000),config(),KEYS,controller.signal,{paceMs:200,wsFactory:(_,opts)=>new WebSocket(`ws://127.0.0.1:${cloud.address().port}`,opts)});
  const rejection=assert.rejects(promise,/取消/);await delay(30);controller.abort();await rejection;
});

test('TTS reads fragmented NDJSON and requires final success, correct resource and PCM16',async()=>{
  const audio=Buffer.alloc(3200,0x23);
  const frames=JSON.stringify({code:0,data:audio.subarray(0,1501).toString('base64')})+'\n'+JSON.stringify({code:0,data:audio.subarray(1501).toString('base64')})+'\n'+JSON.stringify({code:20000000,data:null})+'\n';
  const fetchImpl=async(url,opts)=>{
    assert.equal(url,TTS_URL);assert.equal(opts.headers['X-Api-Key'],KEYS.tts);assert.equal(opts.headers['X-Api-Resource-Id'],'seed-tts-2.0');
    const body=JSON.parse(opts.body);assert.equal(body.req_params.audio_params.format,'pcm');assert.equal(body.req_params.audio_params.sample_rate,16000);
    const bytes=Buffer.from(frames);return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=71)c.enqueue(bytes.subarray(i,i+71));c.close();}}));
  };
  assert.deepEqual(await synthesizePcm('我记得你',config(),KEYS,new AbortController().signal,{fetchImpl}),audio);
  await assert.rejects(synthesizePcm('x',config(),KEYS,null,{fetchImpl:async()=>new Response('{"code":0,"data":"AAAA"}\n')}),/未正常结束/);
  await assert.rejects(synthesizePcm('x',config(),KEYS,null,{fetchImpl:async()=>new Response('{"code":45000000}\n')}),/状态码/);
  await assert.rejects(synthesizePcm('x',config(),KEYS,null,{fetchImpl:async()=>new Response('',{status:401})}),/401/);
});

async function fakeDevice(app,{id='voice-test',begin=true,badAck=false}={}){
  const ws=new WebSocket(`ws://127.0.0.1:${app.address.port}/`,{headers:{'X-Pair-Token':'a'.repeat(64),Origin:'https://github.com/gilmaimon/TinyWebsockets'}});
  const events=[],audio=[];let received=0;
  ws.on('message',(data,binary)=>{
    if(binary){audio.push(Buffer.from(data));received+=data.length;ws.send(JSON.stringify({type:'voice.play.ack',id,received:badAck?received+2:received}));return;}
    const event=JSON.parse(data);events.push(event);
    if(event.type==='voice.play.start')ws.send(JSON.stringify({type:'voice.play.ready',id,capacity:2880000}));
    if(event.type==='voice.play.end')ws.send(JSON.stringify({type:'voice.play.done',id,playedBytes:received}));
  });
  await once(ws,'open');ws.send(JSON.stringify({type:'device.status',voiceVersion:2}));await until(()=>events.some(e=>e.type==='voice.config'));
  async function upload(pcm=Buffer.alloc(9600,0x31)){
    ws.send(JSON.stringify({type:'voice.begin',id,bytes:pcm.length,format:'pcm_s16le',sampleRate:16000,channels:1}));
    await until(()=>events.some(e=>e.type==='voice.upload.ready'));
    for(let n=0;n<pcm.length;n+=1024){const end=Math.min(n+1024,pcm.length);ws.send(pcm.subarray(n,end));await until(()=>events.some(e=>e.type==='voice.upload.ack'&&e.received===end));}
    ws.send(JSON.stringify({type:'voice.end',id,bytes:pcm.length}));
  }
  if(begin)await upload();
  return{ws,events,audio,upload};
}

test('V2 complete pipeline: PCM upload -> ASR -> original DSH owner context -> TTS -> acknowledged PCM playback',async t=>{
  const c=config();
  const called=[],output=Buffer.alloc(4000,0x45);
  const app=await startBridge(c,{log:()=>{},voiceProviders:{
    readKeys:async()=>KEYS,
    recognize:async pcm=>{called.push('asr');assert.equal(pcm.length,9600);return '还记得我吗？';},
    ask:async(text,_config,_signal,{pcm})=>{called.push('dsh');assert.equal(text,'还记得我吗？');assert.equal(pcm.length,9600);return {text:'我记得你呀。'};},
    synthesize:async(text,cfg,keys)=>{called.push('tts');assert.match(text,/我记得你呀/);assert.equal(keys.tts,KEYS.tts);return output;},
  }});t.after(()=>app.stop());
  const d=await fakeDevice(app);t.after(()=>d.ws.terminate());
  await until(()=>d.events.some(e=>e.type==='voice.done'));
  assert.deepEqual(called,['asr','dsh','tts']);assert.deepEqual(Buffer.concat(d.audio),output);
  assert.equal(app.voice.active,null);
  assert.ok(!JSON.stringify(d.events).includes(KEYS.asr));assert.ok(!JSON.stringify(d.events).includes('local-test-token'));
});

test('audio-demo records and returns PCM without any cloud / DSH calls',async t=>{
  const c=config();c.port=0;c.voice.enabled=false;
  const noCall=async()=>assert.fail('No cloud or DSH calls allowed in audio-demo');
  const app=await startBridge(c,{demo:true,audioDemo:true,log:()=>{},voiceProviders:{readKeys:noCall,recognize:noCall,ask:noCall,synthesize:noCall}});t.after(()=>app.stop());
  const d=await fakeDevice(app);t.after(()=>d.ws.terminate());await until(()=>d.events.some(e=>e.type==='voice.done'));
  assert.deepEqual(Buffer.concat(d.audio),Buffer.alloc(9600,0x31));
});

test('voice cancel releases the global turn and does not send delayed cloud results',async t=>{
  const c=config();c.port=0;
  const app=await startBridge(c,{log:()=>{},voiceProviders:{readKeys:async()=>KEYS,recognize:async(_p,_c,_k,signal)=>{await delay(500,undefined,{signal});return '迟到结果';},ask:async()=>assert.fail('DSH should not be called'),synthesize:async()=>assert.fail('TTS should not be called')}});t.after(()=>app.stop());
  const d=await fakeDevice(app);t.after(()=>d.ws.terminate());await until(()=>app.voice.active?.phase==='asr');
  d.ws.send(JSON.stringify({type:'voice.cancel',id:'voice-test'}));await until(()=>!app.voice.active);await delay(30);
  assert.ok(!d.events.some(e=>e.type==='voice.play.start'));
});

test('wrong playback ACK cancels partial audio rather than continuing or claiming success',async t=>{
  const c=config();c.port=0;c.voice.enabled=false;
  const app=await startBridge(c,{demo:true,audioDemo:true,log:()=>{}});t.after(()=>app.stop());
  const d=await fakeDevice(app,{badAck:true});t.after(()=>d.ws.terminate());
  await until(()=>d.events.some(e=>e.type==='voice.error'));
  assert.equal(app.voice.active,null);assert.equal(Buffer.concat(d.audio).length,1024);assert.ok(!d.events.some(e=>e.type==='voice.done'));
});

test('cloud secrets resolve relative to config file and environment keys override file values',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-keys-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const c=config();c.baseDir=dir;c.voice.secretsFile='voice.secrets.json';
  await fs.writeFile(path.join(dir,'voice.secrets.json'),JSON.stringify({asrApiKey:'file-asr-test-only',ttsApiKey:'file-tts-test-only'}));
  assert.deepEqual(await readVoiceKeys(c,{}),{asr:'file-asr-test-only',tts:'file-tts-test-only'});
  assert.deepEqual(await readVoiceKeys(c,{DOUBAO_API_KEY:'shared-test-only',DOUBAO_TTS_API_KEY:'tts-test-override'}),{asr:'shared-test-only',tts:'tts-test-override'});
});
