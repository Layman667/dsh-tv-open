import { readVoiceKeys,recognizePcm,synthesizePcm,BYTES_PER_SECOND } from './doubao.mjs';

function shortText(value,maxBytes=330){let out='';for(const c of String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'')){if(Buffer.byteLength(out+c)>maxBytes)break;out+=c;}return out;}
const ID=/^[A-Za-z0-9_-]{1,48}$/;

export class VoiceHub {
  constructor(config,{send,sendBinary,log=()=>{},audioDemo=false,providers={}}={}){
    Object.assign(this,{config,send,sendBinary,log,audioDemo});
    this.providers={recognize:recognizePcm,ask:async()=>{throw new Error('未连接聊天服务');},synthesize:synthesizePcm,readKeys:readVoiceKeys,...providers};
    this.active=null;this.keys=null;this.tasks=new Set();this.enabled=audioDemo||config.voice.enabled;
  }
  async init(){if(this.enabled&&!this.audioDemo)this.keys=await this.providers.readKeys(this.config);}
  announce(ws){if(ws.supportsVoice)this.send(ws,{type:'voice.config',enabled:this.enabled,maxRecordSeconds:this.config.voice.maxRecordSeconds,maxPlaybackSeconds:this.config.voice.maxPlaybackSeconds,audioDemo:this.audioDemo});}
  state(t,phase){this.check(t);t.phase=phase;this.send(t.ws,{type:'voice.state',id:t.id,state:phase});}
  check(t){t.controller.signal.throwIfAborted();if(this.active!==t)throw new Error('语音会话已结束');}
  fail(t,message='本轮语音已取消，请重试'){
    if(this.active!==t)return;
    clearTimeout(t.uploadTimer);t.controller.abort();
    t.wait?.reject(new Error('语音请求已取消'));t.wait=null;t.chunks=[];
    this.send(t.ws,{type:'voice.error',id:t.id,message:shortText(message,200)});
    this.active=null;
    this.log('[语音] 本轮结束 / 取消；未输出录音、正文或密钥');
  }
  detach(ws){if(this.active?.ws===ws)this.fail(this.active,'设备已断开，本轮取消');}
  handleJson(ws,value){
    if(!value?.type?.startsWith?.('voice.'))return false;
    const t=this.active;
    if(value.type==='voice.begin'){
      if(!ws.supportsVoice||!this.enabled){this.send(ws,{type:'voice.error',id:shortText(value.id||'',48),message:'电脑未启用 V2 语音'});return true;}
      if(t){this.send(ws,{type:'voice.error',id:shortText(value.id||'',48),message:'上一轮语音尚未结束，请稍后再按'});return true;}
      if(typeof value.id!=='string'||!ID.test(value.id)||value.format!=='pcm_s16le'||value.sampleRate!==16000||value.channels!==1||!Number.isInteger(value.bytes)||value.bytes<8000||value.bytes%2||value.bytes>this.config.voice.maxRecordSeconds*BYTES_PER_SECOND){this.send(ws,{type:'voice.error',id:shortText(value.id||'',48),message:'录音格式或长度无效'});return true;}
      const next={ws,id:value.id,phase:'upload',expected:value.bytes,received:0,chunks:[],controller:new AbortController(),wait:null,input:null};
      this.active=next;next.uploadTimer=setTimeout(()=>this.fail(next,'录音上传超时'),30000);
      this.send(ws,{type:'voice.upload.ready',id:next.id});return true;
    }
    if(!t||t.ws!==ws||value.id!==t.id)return true;
    if(value.type==='voice.cancel'||value.type==='voice.error'){this.fail(t,'设备取消了本轮语音');return true;}
    if(value.type==='voice.end'){
      if(t.phase!=='upload'||t.received!==t.expected||value.bytes!==t.expected){this.fail(t,'录音上传不完整');return true;}
      clearTimeout(t.uploadTimer);
      const task=this.run(t).catch(error=>{
        const hints={asr:'语音识别失败：请检查网络、ASR 资源与 API Key',dsh:'DSH 回复失败，请检查电脑端模型和会话',tts:'语音合成失败：请检查 TTS 2.0 音色、资源与 API Key',receiving:'音频下发失败，请检查 Wi-Fi',playing:'设备播放超时或中断'};
        const safeCode=String(error?.message||'').match(/HTTP\s+\d{3}|(?:状态码|服务错误)[：:]\s*\d+/)?.[0]||'';
        if(safeCode)this.log(`[语音] ${t.phase} ${safeCode}`);
        if(this.active===t)this.fail(t,(hints[t.phase]||'本轮语音失败，请检查电脑教程')+(safeCode?`（${safeCode}）`:''));
      }).finally(()=>this.tasks.delete(task));
      this.tasks.add(task);return true;
    }
    if(t.wait&&value.type===t.wait.type){
      if(!t.wait.validate(value)){this.fail(t,'音频传输确认不匹配');return true;}
      const wait=t.wait;t.wait=null;wait.resolve(value);
    }
    return true;
  }
  handleBinary(ws,data){
    const t=this.active;
    if(!t||t.ws!==ws||t.phase!=='upload'){ws.close(1003,'No audio upload active');return;}
    if(!data.length||data.length>1024||data.length%2||t.received+data.length>t.expected){this.fail(t,'录音分包长度无效');return;}
    t.chunks.push(Buffer.from(data));t.received+=data.length;
    this.send(ws,{type:'voice.upload.ack',id:t.id,received:t.received});
  }
  waitFor(t,type,validate,ms){
    this.check(t);
    return new Promise((resolve,reject)=>{
      const abort=()=>done(new Error('语音请求已取消'));
      const timer=setTimeout(()=>done(new Error('等待设备确认超时')),ms);
      const done=(error,value)=>{clearTimeout(timer);t.controller.signal.removeEventListener('abort',abort);if(t.wait?.resolve===ok)t.wait=null;error?reject(error):resolve(value);};
      const ok=v=>done(null,v),bad=e=>done(e);
      t.wait={type,validate,resolve:ok,reject:bad};
      t.controller.signal.addEventListener('abort',abort,{once:true});
    });
  }
  async run(t){
    const pcm=Buffer.concat(t.chunks,t.received);t.chunks=[];
    let audio;
    if(this.audioDemo){this.state(t,'tts');audio=pcm;this.send(t.ws,{type:'voice.transcript',id:t.id,text:'麦克风回放测试（未调用云端或 DSH）'});}
    else{
      this.state(t,'asr');
      const transcript=await this.providers.recognize(pcm,this.config,this.keys,t.controller.signal);this.check(t);
      this.send(t.ws,{type:'voice.transcript',id:t.id,text:shortText(transcript)});
      this.state(t,'dsh');
      const reply=await this.providers.ask(transcript,this.config,t.controller.signal,{pcm,id:t.id});this.check(t);
      if(!reply.published)this.send(t.ws,{type:'chat.reply',text:shortText(reply.text),emotion:'idle'});
      this.state(t,'tts');
      const spoken=[...reply.text].slice(0,this.config.voice.maxSpeakChars).join('');
      if(reply.audioError){this.fail(t,reply.audioError);return;}
      audio=reply.audio??await this.providers.synthesize(spoken,this.config,this.keys,t.controller.signal);this.check(t);
    }
    await this.play(t,audio);this.check(t);
    this.send(t.ws,{type:'voice.done',id:t.id});this.active=null;
    this.log('[语音] 一轮按键语音完成');
  }
  async play(t,audio){
    if(!Buffer.isBuffer(audio)||!audio.length||audio.length%2||audio.length>this.config.voice.maxPlaybackSeconds*BYTES_PER_SECOND)throw new Error('播放音频格式无效');
    this.state(t,'receiving');
    const ready=this.waitFor(t,'voice.play.ready',v=>v.capacity>=audio.length,5000);
    this.send(t.ws,{type:'voice.play.start',id:t.id,format:'pcm_s16le',sampleRate:16000,channels:1,bytes:audio.length});
    await ready;
    for(let offset=0;offset<audio.length;offset+=1024){
      this.check(t);const end=Math.min(offset+1024,audio.length);
      const ack=this.waitFor(t,'voice.play.ack',v=>v.received===end,5000);
      this.sendBinary(t.ws,audio.subarray(offset,end));await ack;
    }
    this.state(t,'playing');
    const done=this.waitFor(t,'voice.play.done',v=>v.playedBytes===audio.length,Math.ceil(audio.length/BYTES_PER_SECOND*1000)+15000);
    this.send(t.ws,{type:'voice.play.end',id:t.id,bytes:audio.length});await done;
  }
  async stop(){if(this.active)this.fail(this.active,'电脑桥接停止');await Promise.allSettled(this.tasks);}
}
