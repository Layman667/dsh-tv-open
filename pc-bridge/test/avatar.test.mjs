import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { AvatarHub,parseDfa,decodeRle,envelope } from '../lib/avatar.mjs';
import { startBridge } from '../lib/bridge.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const assetDir=path.join(root,'assets/esp32');
import { deviceConfig } from '../../app/config.mjs';
const cfg=()=>deviceConfig({device:{host:'127.0.0.1',port:18765,token:'a'.repeat(64)},voice:{}});
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await delay(10);}assert.fail('Timed out');}

test('all 242 converted assets have verified headers, checksums and exact RGB565 pixel counts',async()=>{
  const manifest=JSON.parse(await fs.readFile(path.join(assetDir,'manifest.json'),'utf8'));
  assert.equal(manifest.assets.filter(a=>a.kind==='motion').length,106);
  assert.equal(manifest.assets.filter(a=>a.kind==='expression').length,133);
  assert.equal(manifest.assets.filter(a=>a.kind==='role').length,3);
  for(const a of manifest.assets){const data=await fs.readFile(path.join(assetDir,a.file));const frames=parseDfa(data,a);for(const frame of frames)assert.equal(decodeRle(frame).length,32768);}
  assert.throws(()=>decodeRle(Buffer.from([0,0])));
  assert.throws(()=>decodeRle(Buffer.from([1,128])));
  assert.throws(()=>decodeRle(Buffer.from([255,255,0,0])));
});

test('actual action progress, pause, loop, expression and unknown custom assets select correctly',async()=>{
  const hub=new AvatarHub(cfg());await hub.init();await hub.stop();
  const asset=hub.manifest.assets.find(a=>a.kind==='motion'&&a.name===hub.manifest.defaults.happy);
  const s={mode:'motion',name:asset.name,timeMs:500,receivedAt:Date.now(),paused:true,loop:false,flip:true};
  assert.equal(hub.select(s).frame,4);assert.equal(hub.select(s).flip,true);assert.equal(hub.select(s).live,true);
  assert.equal(hub.select({...s,timeMs:1e6}).frame,asset.frames-1);
  assert.equal(hub.select({...s,timeMs:1e6,loop:true}).frame,Math.floor(1e6*8/1000)%asset.frames);
  const expr=hub.manifest.assets.find(a=>a.kind==='expression');
  assert.equal(hub.select({mode:'expression',name:expr.name+'.png',pack:expr.pack}).asset.id,expr.id);
  assert.equal(hub.select({...s,name:'a-custom-action'}).live,false);
});

test('V2 graphics and PCM envelopes coexist; image ACK applies backpressure; old voice clients remain supported',async t=>{
  const c=cfg();c.port=0;const app=await startBridge(c,{demo:true,audioDemo:true,log:()=>{}});t.after(()=>app.stop());
  const ws=new WebSocket(`ws://127.0.0.1:${app.address.port}`,{headers:{'X-Pair-Token':c.pairToken}});await once(ws,'open');t.after(()=>ws.terminate());
  let frame=null,chunks=[],frameCount=0,done=false;const pcm=Buffer.alloc(8192,0x4d),audio=[];
  ws.on('message',(data,binary)=>{
    if(binary){assert.equal(data.toString('ascii',0,4),'DFTV');assert.equal(data[4],1);assert.equal(data.readUInt16LE(6),data.length-16);
      if(data[5]===1){assert.equal(data.readUInt32LE(8),frame.seq);assert.equal(data.readUInt32LE(12),Buffer.concat(chunks).length);chunks.push(data.subarray(16));}
      else{assert.equal(data[5],2);audio.push(data.subarray(16));ws.send(JSON.stringify({type:'voice.play.ack',id:'turn1',received:Buffer.concat(audio).length}));}return;}
    const p=JSON.parse(data);if(p.type==='avatar.frame'){frame=p;frameCount++;chunks=[];}
    if(p.type==='voice.upload.ready'){for(let i=0;i<pcm.length;i+=1024)ws.send(pcm.subarray(i,i+1024));ws.send(JSON.stringify({type:'voice.end',id:'turn1',bytes:pcm.length}));}
    if(p.type==='voice.play.start')ws.send(JSON.stringify({type:'voice.play.ready',id:'turn1',capacity:100000}));
    if(p.type==='voice.play.end'){assert.deepEqual(Buffer.concat(audio),pcm);ws.send(JSON.stringify({type:'voice.play.done',id:'turn1',playedBytes:pcm.length}));}
    if(p.type==='voice.done')done=true;
  });
  ws.send(JSON.stringify({type:'device.status',voiceVersion:2,avatarVersion:1,binaryEnvelope:1}));
  await until(()=>frame&&Buffer.concat(chunks).length===frame.bytes);assert.equal(decodeRle(Buffer.concat(chunks)).length,32768);
  await delay(300);assert.equal(frameCount,1);ws.send(JSON.stringify({type:'avatar.ack',seq:frame.seq,ok:true}));await until(()=>frameCount>1);
  ws.send(JSON.stringify({type:'voice.begin',id:'turn1',format:'pcm_s16le',sampleRate:16000,channels:1,bytes:pcm.length}));await until(()=>done);
  assert.throws(()=>envelope(1,Buffer.alloc(1025)));
});
