import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ASSETS=fileURLToPath(new URL('../../assets/esp32/',import.meta.url));
export function envelope(kind,payload,seq=0,offset=0){
  if(![1,2].includes(kind)||!payload.length||payload.length>1024)throw new Error('Invalid binary payload');
  const out=Buffer.alloc(16+payload.length);out.write('DFTV');out[4]=1;out[5]=kind;out.writeUInt16LE(payload.length,6);out.writeUInt32LE(seq>>>0,8);out.writeUInt32LE(offset>>>0,12);payload.copy(out,16);return out;
}
export function decodeRle(data,width=128,height=128){
  const output=Buffer.alloc(width*height*2);let p=0,n=0;
  while(p<data.length){
    if(p+2>data.length)throw new Error('Truncated RLE');
    const command=data.readUInt16LE(p);p+=2;const count=command&32767;
    if(!count||n+count>width*height)throw new Error('RLE bounds');
    if(command&32768){if(p+2>data.length)throw new Error('Truncated repeat');const color=data.readUInt16LE(p);p+=2;for(let i=0;i<count;i++)output.writeUInt16LE(color,2*(n+i));}
    else {if(p+count*2>data.length)throw new Error('Truncated literals');data.copy(output,n*2,p,p+count*2);p+=count*2;}
    n+=count;
  }
  if(n!==width*height)throw new Error('RLE pixel count');return output;
}
export function parseDfa(data,asset){
  if(data.length!==asset.bytes||createHash('sha256').update(data).digest('hex')!==asset.sha256)throw new Error('Asset checksum');
  if(data.toString('ascii',0,4)!=='DFA1'||data.readUInt16LE(4)!==128||data.readUInt16LE(6)!==128||data.readUInt16LE(10)!==asset.frames||data.readUInt16LE(8)!==asset.fps)throw new Error('Asset header');
  const frames=[];let previous=16+asset.frames*8;
  for(let i=0;i<asset.frames;i++){
    const start=data.readUInt32LE(16+i*8),size=data.readUInt32LE(20+i*8);
    if(start!==previous||size<4||size>40000||start+size>data.length)throw new Error('Asset index');
    frames.push(data.subarray(start,start+size));previous=start+size;
  }
  if(previous!==data.length)throw new Error('Asset trailing data');return frames;
}
export class AvatarHub {
  constructor(config,{send,sendBinary,readVisual=async()=>null,log=()=>{},assetDir=ASSETS}={}){
    Object.assign(this,{config,send,sendBinary,readVisual,log,assetDir});this.devices=new Map();this.cache=new Map();this.visual=null;this.fallback='idle';this.seq=0;this.pending=false;this.stopped=false;
  }
  async init(){this.manifest=JSON.parse(await fs.readFile(path.join(this.assetDir,'manifest.json'),'utf8'));this.timer=setInterval(()=>this.tick().catch(()=>{}),125);}
  attach(ws){if(!this.devices.has(ws))this.devices.set(ws,{pending:0,sentAt:0,key:''});}
  detach(ws){this.devices.delete(ws);}
  observe(packet){if(packet.emotion)this.fallback=packet.emotion;else if(packet.type==='chat.state')this.fallback=packet.state==='speaking'?'happy':packet.state;else if(packet.type==='voice.state')this.fallback=packet.state==='upload'?'listening':'thinking';else if(packet.type==='voice.done'||packet.type==='voice.error')this.fallback='idle';}
  handleJson(ws,p){if(p?.type!=='avatar.ack')return false;const device=this.devices.get(ws);if(device&&p.seq===device.pending){device.pending=0;if(!p.ok)device.key='';}return true;}
  select(s){
    let asset,position=Date.now();
    if(s?.mode==='motion'){
      asset=this.manifest.assets.find(a=>a.kind==='motion'&&a.name===s.name);
      position=s.timeMs+(s.paused?0:Math.max(0,Date.now()-s.receivedAt));
    }else if(s?.mode==='expression')asset=this.manifest.assets.find(a=>a.kind==='expression'&&a.pack===s.pack&&a.name+'.png'===s.name);
    else if(s?.mode==='role')asset=this.manifest.assets.find(a=>a.kind==='role'&&a.name+'.png'===s.name);
    const live=Boolean(asset);
    if(!asset)asset=this.manifest.assets.find(a=>a.kind==='motion'&&a.name===(this.manifest.defaults[this.fallback]||this.manifest.defaults.idle));
    let frame=Math.floor(position*asset.fps/1000);
    frame=live&&s.mode==='motion'&&!s.loop?Math.min(asset.frames-1,frame):frame%asset.frames;
    return {asset,frame,flip:live&&s.flip===true,live};
  }
  async frames(asset){
    if(this.cache.has(asset.id))return this.cache.get(asset.id);
    const frames=parseDfa(await fs.readFile(path.join(this.assetDir,asset.file)),asset);this.cache.set(asset.id,frames);
    if(this.cache.size>3)this.cache.delete(this.cache.keys().next().value);return frames;
  }
  async tick(){
    if(this.pending||this.stopped||!this.devices.size)return;
    this.pending=true;
    try{
      this.visual=await this.readVisual();const selected=this.select(this.visual),{asset,frame,flip,live}=selected;
      const data=(await this.frames(asset))[frame],key=`${asset.id}:${frame}:${flip}`;
      if(this.stopped)return;
      for(const [ws,device] of this.devices){
        if(ws.readyState!==1)continue;
        if(device.pending){if(Date.now()-device.sentAt>5000){ws.terminate();this.detach(ws);}continue;}
        if(device.key===key&&Date.now()-device.sentAt<1000)continue;
        if(ws.bufferedAmount>8192)continue;
        const seq=this.seq=(this.seq+1)>>>0||1;device.pending=seq;device.sentAt=Date.now();device.key=key;
        this.send(ws,{type:'avatar.frame',seq,bytes:data.length,width:128,height:128,flip,live,asset:asset.id,frame});
        for(let offset=0;offset<data.length;offset+=1024)this.sendBinary(ws,envelope(1,data.subarray(offset,offset+1024),seq,offset));
      }
    }finally{this.pending=false;}
  }
  async stop(){this.stopped=true;clearInterval(this.timer);while(this.pending)await new Promise(r=>setTimeout(r,10));this.devices.clear();this.cache.clear();}
}
