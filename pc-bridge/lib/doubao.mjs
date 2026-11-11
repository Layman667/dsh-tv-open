import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

export const ASR_URL='wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
export const TTS_URL='https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const SAMPLE_RATE=16000;
export const BYTES_PER_SECOND=32000;

export async function readVoiceKeys(config,env=process.env) {
  let file={};
  try { file=JSON.parse((await fs.readFile(path.resolve(config.baseDir||process.cwd(),config.voice.secretsFile),'utf8')).replace(/^\uFEFF/,'')); }
  catch(error) { if(error.code!=='ENOENT') throw new Error('语音密钥文件不是有效 JSON'); }
  const asr=env.DOUBAO_ASR_API_KEY||env.DOUBAO_API_KEY||file.asrApiKey;
  const tts=env.DOUBAO_TTS_API_KEY||env.DOUBAO_API_KEY||file.ttsApiKey;
  if([asr,tts].some(k=>typeof k!=='string'||k.length<8||k.length>2048||/[\r\n]/.test(k)||/填|your_|replace/i.test(k))) throw new Error('请在电脑的 voice.secrets.json 或环境变量中填写豆包 ASR / TTS API Key');
  return {asr,tts};
}

// Volcengine v3 SAUC: four-byte header, optional sequence, payload size, payload.
export function asrFrame(type,flags,body,{json=false,gzip=true}={}) {
  let payload=json?Buffer.from(JSON.stringify(body)):Buffer.from(body);
  if(gzip)payload=gzipSync(payload);
  const length=Buffer.alloc(4);length.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from([0x11,(type<<4)|flags,(json?0x10:0)|(gzip?1:0),0]),length,payload]);
}

export function parseAsrFrame(input) {
  const bytes=Buffer.from(input);
  if(bytes.length<8||(bytes[0]>>4)!==1)throw new Error('ASR 二进制响应头无效');
  const type=bytes[1]>>4,flags=bytes[1]&15,serialization=bytes[2]>>4,compression=bytes[2]&15;
  if(type!==9&&type!==15)throw new Error('ASR 响应消息类型无效');
  let offset=(bytes[0]&15)*4,sequence=null,errorCode=null;
  if(offset<4||offset>bytes.length-4)throw new Error('ASR 响应头长度无效');
  if(type===15){if(offset+8>bytes.length)throw new Error('ASR 错误帧不完整');errorCode=bytes.readUInt32BE(offset);offset+=4;}
  else if(flags&1){if(offset+8>bytes.length)throw new Error('ASR 序号帧不完整');sequence=bytes.readInt32BE(offset);offset+=4;}
  const size=bytes.readUInt32BE(offset);offset+=4;
  if(size!==bytes.length-offset||size>1024*1024)throw new Error('ASR 响应长度无效');
  if(compression!==0&&compression!==1)throw new Error('ASR 响应压缩格式不支持');
  let payload=bytes.subarray(offset);
  if(compression===1)payload=gunzipSync(payload,{maxOutputLength:1024*1024});
  let body={};
  if(serialization===1)body=JSON.parse(payload.toString('utf8'));
  else if(type!==15)throw new Error('ASR 响应不是 JSON');
  if(errorCode)throw new Error(`豆包 ASR 服务错误：${errorCode}`);
  const root=body.payload_msg||body;
  if(root.code!==undefined&&![0,20000000].includes(Number(root.code)))throw new Error(`豆包 ASR 状态码：${Number(root.code)||'invalid'}`);
  const result=root.result;
  const text=typeof result?.text==='string'?result.text:Array.isArray(result)?result.map(x=>x?.text||'').join(''):'';
  return {type,flags,sequence,body,text,final:Boolean(flags&2)||sequence<0||body.is_last_package===true};
}

export function recognizePcm(pcm,config,keys,signal,{wsFactory=(url,opts)=>new WebSocket(url,opts),paceMs=200}={}) {
  if(!Buffer.isBuffer(pcm)||pcm.length%2||pcm.length<8000||pcm.length>config.voice.maxRecordSeconds*BYTES_PER_SECOND)throw new Error('录音长度或 PCM16 格式无效');
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let settled=false,finalText='';
    const controller=new AbortController();
    const socket=wsFactory(ASR_URL,{headers:{'X-Api-Key':keys.asr,'X-Api-Resource-Id':config.voice.asrResourceId,'X-Api-Request-Id':randomUUID(),'X-Api-Sequence':'-1'},handshakeTimeout:10000,maxPayload:1024*1024,perMessageDeflate:false,followRedirects:false});
    const finish=(error,text)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();socket.on('error',()=>{});socket.terminate();
      error?reject(error):resolve(text);
    };
    const abort=()=>finish(new Error('语音请求已取消'));
    const timer=setTimeout(()=>finish(new Error('豆包 ASR 超时')),config.voice.cloudTimeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    socket.on('unexpected-response',(req,res)=>{res.resume();req.destroy();finish(new Error(`豆包 ASR 握手失败：HTTP ${res.statusCode}`));});
    socket.on('error',()=>finish(new Error('豆包 ASR 连接失败；请核对网络、API Key 和开通资源')));
    socket.on('close',()=>{if(!settled)finish(new Error('豆包 ASR 未返回最终结果就断开'));});
    socket.on('message',(bytes,binary)=>{
      if(settled)return;
      try{
        if(!binary)throw new Error('ASR 应返回二进制协议帧');
        const response=parseAsrFrame(bytes);
        if(response.text)finalText=response.text;
        if(response.final){
          const text=finalText.trim();
          if(!text)throw new Error('没有识别到文字，请靠近麦克风重新说');
          if(text.length>1000)throw new Error('识别文字超过 DSH 输入上限，请分次说');
          finish(null,text);
        }
      }catch(error){finish(error);}
    });
    socket.on('open',async()=>{
      try{
        socket.send(asrFrame(1,0,{user:{uid:'dsh-esp32-voice'},audio:{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1},request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,show_utterances:false}},{json:true}));
        for(let offset=0;offset<pcm.length&&!settled;offset+=6400){
          if(offset)await delay(paceMs,undefined,{signal:controller.signal});
          if(settled)return;
          const end=Math.min(offset+6400,pcm.length);
          socket.send(asrFrame(2,end===pcm.length?2:0,pcm.subarray(offset,end)));
        }
      }catch(error){if(!settled)finish(new Error('ASR 音频上传失败'));}
    });
  });
}

export async function synthesizePcm(text,config,keys,signal,{fetchImpl=fetch}={}) {
  signal?.throwIfAborted();
  const timeout=AbortSignal.timeout(config.voice.cloudTimeoutMs);
  const response=await fetchImpl(TTS_URL,{
    method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Api-Key':keys.tts,'X-Api-Resource-Id':'seed-tts-2.0','X-Api-Request-Id':randomUUID()},
    body:JSON.stringify({user:{uid:'dsh-esp32-voice'},req_params:{text,speaker:config.voice.speaker,audio_params:{format:'pcm',sample_rate:16000,speech_rate:config.voice.speechRate}}}),
    signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
  if(!response.ok)throw new Error(`豆包 TTS 请求失败：HTTP ${response.status}`);
  const chunks=[];let total=0,buffer='',complete=false;
  const decoder=new TextDecoder();
  const parseLine=line=>{
    line=line.trim();if(!line||line.startsWith(':')||line.startsWith('event:')||line.startsWith('id:')||line.startsWith('retry:'))return;
    if(line.startsWith('data:'))line=line.slice(5).trim();
    if(line==='[DONE]')return;
    const frame=JSON.parse(line),code=Number(frame.code);
    if(![0,20000000].includes(code))throw new Error(`豆包 TTS 状态码：${Number.isFinite(code)?code:'invalid'}`);
    if(complete)throw new Error('TTS 完成帧后仍有数据');
    if(typeof frame.data==='string'&&frame.data){
      if(frame.data.length>4*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)||frame.data.length%4)throw new Error('TTS 音频编码无效');
      const pcm=Buffer.from(frame.data,'base64');total+=pcm.length;
      if(total>config.voice.maxPlaybackSeconds*BYTES_PER_SECOND)throw new Error('合成音频过长，请缩短朗读字数');
      chunks.push(pcm);
    }
    if(code===20000000)complete=true;
  };
  try{
    for await(const chunk of response.body){
      buffer+=decoder.decode(chunk,{stream:true});
      if(buffer.length>6*1024*1024)throw new Error('TTS 单帧响应过大');
      let n;while((n=buffer.indexOf('\n'))>=0){parseLine(buffer.slice(0,n));buffer=buffer.slice(n+1);}
    }
    buffer+=decoder.decode();if(buffer.trim())parseLine(buffer);
  }catch(error){throw new Error(signal?.aborted?'语音请求已取消':`TTS 音频读取失败：${error.message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,90)}`);}
  if(!complete||total===0||total%2)throw new Error('TTS 未正常结束，或没有返回完整 PCM16 音频');
  const audio=Buffer.concat(chunks,total);
  if(audio.subarray(0,4).toString()==='RIFF')throw new Error('TTS 返回 WAV，当前协议要求裸 PCM16');
  return audio;
}
