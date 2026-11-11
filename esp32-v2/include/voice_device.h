#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>
#include <atomic>
#include <algorithm>
#include <esp_random.h>

#ifndef DSH_MIC_GAIN
#define DSH_MIC_GAIN 4
#endif
#ifndef DSH_SPEAKER_VOLUME
#define DSH_SPEAKER_VOLUME 25
#endif
static_assert(DSH_MIC_GAIN >= 1 && DSH_MIC_GAIN <= 32, "Mic gain must be 1..32");
static_assert(DSH_SPEAKER_VOLUME >= 0 && DSH_SPEAKER_VOLUME <= 100, "Volume must be 0..100");

class VoiceDevice {
 public:
  static constexpr uint32_t RATE=16000, RECORD_CAP=15*32000, PLAY_CAP=90*32000;
  enum class Phase { Idle,Recording,UploadReady,Upload,Waiting,Receiving,Playing,ServerDone,Cancelling };

  bool begin(websockets::WebsocketsClient* client){
    socket=client;pinMode(8,INPUT_PULLUP);rawButton=stableButton=digitalRead(8);
    if(!psramFound()){setCaption("没有检测到PSRAM，请选R8配置");return false;}
    record=static_cast<uint8_t*>(heap_caps_malloc(RECORD_CAP,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    playback=static_cast<uint8_t*>(heap_caps_malloc(PLAY_CAP,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    mutex=xSemaphoreCreateMutex();
    if(!record||!playback||!mutex){setCaption("音频内存分配失败");return false;}
    i2s_chan_config_t channel=I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0,I2S_ROLE_MASTER);
    channel.dma_desc_num=8;channel.dma_frame_num=256;channel.auto_clear=true;
    if(i2s_new_channel(&channel,&tx,&rx)!=ESP_OK){setCaption("I2S通道创建失败");return false;}
    i2s_std_config_t standard={};
    standard.clk_cfg=I2S_STD_CLK_DEFAULT_CONFIG(RATE);
    standard.slot_cfg=I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,I2S_SLOT_MODE_STEREO);
    standard.gpio_cfg.mclk=I2S_GPIO_UNUSED;
    standard.gpio_cfg.bclk=GPIO_NUM_5;standard.gpio_cfg.ws=GPIO_NUM_6;
    standard.gpio_cfg.dout=GPIO_NUM_7;standard.gpio_cfg.din=GPIO_NUM_4;
    if(i2s_channel_init_std_mode(tx,&standard)!=ESP_OK||i2s_channel_init_std_mode(rx,&standard)!=ESP_OK||i2s_channel_enable(tx)!=ESP_OK||i2s_channel_enable(rx)!=ESP_OK){setCaption("I2S初始化失败，请查接线");return false;}
    if(xTaskCreatePinnedToCore(captureEntry,"dfy-capture",4096,this,2,&captureTask,0)!=pdPASS||xTaskCreatePinnedToCore(playEntry,"dfy-play",4096,this,2,&playTask,1)!=pdPASS){setCaption("音频任务创建失败");return false;}
    ready=true;setCaption("等待电脑开启语音");return true;
  }
  const char* caption()const{return captionText;}
  uint32_t revision()const{return captionRevision;}
  bool isRecording()const{return phase==Phase::Recording;}
  bool isPlaying()const{return phase==Phase::Playing;}
  bool isBusy()const{return phase!=Phase::Idle;}
  bool matchesId(const char* value)const{return id[0]&&strcmp(value,id)==0;}

  void tick(bool online){
    const uint32_t now=millis();
    if(wasOnline&&!online){enabled=false;abortLocal("电脑断开，本轮已取消",false);}
    wasOnline=online;
    if(phase==Phase::Recording&&captureFailed.load())abortLocal("麦克风采样失败，请看串口",true);
    if(phase==Phase::Cancelling&&!playActive.load()){phase=Phase::Idle;playDone=false;}
    if(phase==Phase::Recording&&recordFull.load())finishRecording();
    if(phase==Phase::Upload&&!awaitingAck){
      if(sentOffset==recordBytes){send("voice.end",recordBytes,"bytes");phase=Phase::Waiting;deadline=now+600000;setCaption("正在上传识别，请稍等");}
      else{
        const uint32_t count=std::min<uint32_t>(1024,recordBytes-sentOffset);
        expectedAck=sentOffset+count;awaitingAck=true;deadline=now+5000;
        if(!socket->sendBinary(reinterpret_cast<const char*>(record+sentOffset),count))abortLocal("录音发送失败",true);
      }
    }
    if(phase==Phase::Playing&&playDone.exchange(false)){
      if(playFailed.load()){abortLocal("I2S播放失败，请查供电",true);}
      else{send("voice.play.done",playBytes,"playedBytes");phase=Phase::ServerDone;deadline=now+8000;}
    }
    if(phase!=Phase::Idle&&phase!=Phase::Recording&&phase!=Phase::Playing&&phase!=Phase::Cancelling&&static_cast<int32_t>(now-deadline)>=0)abortLocal("语音等待超时，请重试",true);
    const bool raw=digitalRead(8);
    if(raw!=rawButton){rawButton=raw;buttonChangedAt=now;}
    if(raw!=stableButton&&now-buttonChangedAt>=35){
      stableButton=raw;
      if(!stableButton){
        if(phase!=Phase::Idle){setCaption("请等本轮说完再按");}
        else if(!ready||captureFailed.load())setCaption("音频未就绪，请看串口");
        else if(!online||!enabled)setCaption("先连电脑并开启V2语音");
        else startRecording();
      }else if(phase==Phase::Recording)finishRecording();
    }
  }

  bool handleJson(JsonObjectConst doc){
    const char* type=doc["type"]|"";
    if(strncmp(type,"voice.",6)!=0)return false;
    if(strcmp(type,"voice.config")==0){
      enabled=doc["enabled"]|false;
      recordLimit=std::min<uint32_t>(RECORD_CAP,std::max<uint32_t>(32000,(doc["maxRecordSeconds"]|15)*32000u));
      playLimit=std::min<uint32_t>(PLAY_CAP,std::max<uint32_t>(32000,(doc["maxPlaybackSeconds"]|90)*32000u));
      audioDemo=doc["audioDemo"]|false;
      if(phase==Phase::Idle&&ready)setCaption(enabled?(audioDemo?"回放测试：按住按钮录音":"按住按钮说话，松开提交"):"电脑尚未开启V2语音");
      return true;
    }
    const char* incomingId=doc["id"]|"";
    if(strcmp(incomingId,id)!=0||phase==Phase::Idle)return true;
    if(strcmp(type,"voice.error")==0||strcmp(type,"voice.cancel")==0){abortLocal("电脑取消本轮，请看回复提示",false);return true;}
    if(strcmp(type,"voice.state")==0){
      const char* state=doc["state"]|"";
      if(strcmp(state,"asr")==0)setCaption("豆包识别中");
      if(strcmp(state,"dsh")==0)setCaption("DSH思考中，沿用QQ会话");
      if(strcmp(state,"tts")==0)setCaption(audioDemo?"准备回放测试":"豆包合成语音中");
      if(strcmp(state,"receiving")==0)setCaption("接收语音中");
      if(strcmp(state,"playing")==0)setCaption("正在播放，暂停收音");
      deadline=millis()+600000;return true;
    }
    if(strcmp(type,"voice.transcript")==0){setCaption(audioDemo?"麦克风回放测试":"已识别，交给DSH");return true;}
    if(strcmp(type,"voice.upload.ready")==0&&phase==Phase::UploadReady){phase=Phase::Upload;sentOffset=0;awaitingAck=false;return true;}
    if(strcmp(type,"voice.upload.ack")==0&&phase==Phase::Upload&&awaitingAck){
      const uint32_t received=doc["received"]|0u;
      if(received!=expectedAck){abortLocal("录音确认不匹配",true);return true;}
      sentOffset=received;awaitingAck=false;return true;
    }
    if(strcmp(type,"voice.play.start")==0&&phase==Phase::Waiting){
      const uint32_t bytes=doc["bytes"]|0u;
      if(bytes==0||bytes>playLimit||bytes%2||(doc["sampleRate"]|0)!=16000||(doc["channels"]|0)!=1||strcmp(doc["format"]|"","pcm_s16le")!=0){abortLocal("播放格式或大小不支持",true);return true;}
      playBytes=bytes;receivedBytes=0;phase=Phase::Receiving;deadline=millis()+15000;
      send("voice.play.ready",PLAY_CAP,"capacity");return true;
    }
    if(strcmp(type,"voice.play.end")==0&&phase==Phase::Receiving){
      if(receivedBytes!=playBytes||(doc["bytes"]|0u)!=playBytes){abortLocal("语音接收不完整",true);return true;}
      playCancel=false;playFailed=false;playDone=false;playActive=true;phase=Phase::Playing;
      xTaskNotifyGive(playTask);setCaption("正在说话，暂不收音");return true;
    }
    if(strcmp(type,"voice.done")==0&&phase==Phase::ServerDone){phase=Phase::Idle;setCaption(audioDemo?"回放完成，可再按一次":"按住按钮说话，松开提交");return true;}
    return true;
  }

  void handleBinary(const char* data,size_t length){
    if(phase!=Phase::Receiving||!length||length>1024||length%2||receivedBytes+length>playBytes){abortLocal("音频分包无效",true);return;}
    memcpy(playback+receivedBytes,data,length);receivedBytes+=length;deadline=millis()+15000;
    send("voice.play.ack",receivedBytes,"received");
  }

 private:
  websockets::WebsocketsClient* socket=nullptr;
  i2s_chan_handle_t tx=nullptr,rx=nullptr;
  SemaphoreHandle_t mutex=nullptr;
  TaskHandle_t captureTask=nullptr,playTask=nullptr;
  uint8_t *record=nullptr,*playback=nullptr;
  std::atomic<bool> recording{false},recordFull{false},captureFailed{false},playCancel{false},playActive{false},playDone{false},playFailed{false};
  std::atomic<uint32_t> recordLimit{RECORD_CAP};
  uint32_t recordBytes=0,playBytes=0,playLimit=PLAY_CAP,receivedBytes=0,sentOffset=0,expectedAck=0,deadline=0,buttonChangedAt=0;
  bool ready=false,enabled=false,wasOnline=false,rawButton=true,stableButton=true,awaitingAck=false,audioDemo=false;
  Phase phase=Phase::Idle;
  char id[32]={0},captionText[128]="音频初始化中";
  uint32_t captionRevision=0;

  void setCaption(const char* s){if(strcmp(captionText,s)!=0){snprintf(captionText,sizeof(captionText),"%s",s);++captionRevision;}}
  void send(const char* type,uint32_t value=0,const char* key=nullptr){
    if(!socket||!socket->available())return;
    StaticJsonDocument<256> doc;doc["type"]=type;doc["id"]=id;if(key)doc[key]=value;
    char buffer[256];serializeJson(doc,buffer,sizeof(buffer));socket->send(buffer);
  }
  void startRecording(){
    snprintf(id,sizeof(id),"%08lx-%08lx",static_cast<unsigned long>(esp_random()),static_cast<unsigned long>(millis()));
    xSemaphoreTake(mutex,portMAX_DELAY);recordBytes=0;recordFull=false;recording=true;xSemaphoreGive(mutex);
    phase=Phase::Recording;setCaption("录音中，松开按钮提交");
  }
  void finishRecording(){
    xSemaphoreTake(mutex,portMAX_DELAY);recording=false;const uint32_t bytes=recordBytes;xSemaphoreGive(mutex);
    if(bytes<8000){phase=Phase::Idle;setCaption("太短了，请按住半秒再说");return;}
    StaticJsonDocument<256> doc;doc["type"]="voice.begin";doc["id"]=id;doc["bytes"]=bytes;doc["sampleRate"]=16000;doc["channels"]=1;doc["format"]="pcm_s16le";
    char buffer[256];serializeJson(doc,buffer,sizeof(buffer));
    phase=Phase::UploadReady;deadline=millis()+5000;setCaption("录音完成，等待电脑接收");
    if(!socket->send(buffer))abortLocal("电脑连接中断",false);
  }
  void abortLocal(const char* reason,bool notify){
    recording=false;playCancel=true;awaitingAck=false;
    if(notify&&phase!=Phase::Idle)send("voice.cancel");
    phase=playActive.load()?Phase::Cancelling:Phase::Idle;setCaption(reason);
  }
  static void captureEntry(void* p){static_cast<VoiceDevice*>(p)->captureLoop();}
  static void playEntry(void* p){static_cast<VoiceDevice*>(p)->playLoop();}
  void captureLoop(){
    int32_t samples[256];
    for(;;){
      size_t bytes=0;const esp_err_t error=i2s_channel_read(rx,samples,sizeof(samples),&bytes,100);
      if(error!=ESP_OK&&error!=ESP_ERR_TIMEOUT){captureFailed=true;recording=false;vTaskDelay(pdMS_TO_TICKS(10));continue;}
      if(!recording.load())continue;
      xSemaphoreTake(mutex,portMAX_DELAY);
      if(recording.load())for(size_t i=0;i+1<bytes/sizeof(int32_t);i+=2){
        if(recordBytes+2>recordLimit.load()){recording=false;recordFull=true;break;}
        // INMP441 L/R=GND -> left 32-bit Philips I2S slot; 24-bit data is MSB aligned.
        int64_t value=static_cast<int64_t>(samples[i]>>16)*DSH_MIC_GAIN;
        value=std::max<int64_t>(-32768,std::min<int64_t>(32767,value));
        const int16_t sample=static_cast<int16_t>(value);
        record[recordBytes++]=sample&0xff;record[recordBytes++]=(static_cast<uint16_t>(sample)>>8)&0xff;
      }
      xSemaphoreGive(mutex);
    }
  }
  void playLoop(){
    int32_t stereo[256];
    for(;;){
      ulTaskNotifyTake(pdTRUE,portMAX_DELAY);
      uint32_t offset=0;
      while(offset<playBytes&&!playCancel.load()){
        const size_t count=std::min<uint32_t>(128,(playBytes-offset)/2);
        for(size_t i=0;i<count;++i){
          const int16_t sample=static_cast<int16_t>(static_cast<uint16_t>(playback[offset+2*i])|(static_cast<uint16_t>(playback[offset+2*i+1])<<8));
          const int32_t scaled=static_cast<int32_t>((static_cast<int64_t>(sample)*DSH_SPEAKER_VOLUME*65536)/100);
          stereo[2*i]=scaled;stereo[2*i+1]=scaled;
        }
        size_t written=0;
        if(i2s_channel_write(tx,stereo,count*8,&written,1000)!=ESP_OK||written!=count*8){playFailed=true;break;}
        offset+=count*2;
      }
      // Flush at least a complete DMA queue before reporting audible completion.
      memset(stereo,0,sizeof(stereo));
      for(int i=0;i<18;++i){size_t written=0;if(i2s_channel_write(tx,stereo,sizeof(stereo),&written,1000)!=ESP_OK){playFailed=true;break;}}
      playActive=false;playDone=true;
    }
  }
};
