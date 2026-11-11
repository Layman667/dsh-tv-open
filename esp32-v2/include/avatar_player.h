#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <TFT_eSPI.h>
#include <esp_heap_caps.h>
#include "avatar_assets.h"

#ifndef DSH_AVATAR_MIRROR
#define DSH_AVATAR_MIRROR 0
#endif

// RGB565, 128 x 128; image reception is separate from V2 PCM reception.
class AvatarPlayer {
  uint8_t* encoded=nullptr;
  uint16_t* pixels=nullptr;
  websockets::WebsocketsClient* socket=nullptr;
  uint32_t expected=0,received=0,sequence=0,lastRemote=0,lastFallback=UINT32_MAX;
  bool flip=false,dirty=true,ready=false;
  static uint16_t u16(const uint8_t* p){return uint16_t(p[0])|(uint16_t(p[1])<<8);}
  static uint32_t u32(const uint8_t* p){return uint32_t(u16(p))|(uint32_t(u16(p+2))<<16);}
  void ack(bool ok){if(socket&&socket->available()){char p[96];snprintf(p,sizeof(p),"{\"type\":\"avatar.ack\",\"seq\":%lu,\"ok\":%s}",static_cast<unsigned long>(sequence),ok?"true":"false");socket->send(p);}}
  bool decode(const uint8_t* data,size_t size,bool mirrored){
    if(!pixels)return false;
    size_t offset=0,index=0;
    while(offset<size){
      if(offset+2>size)return false;
      uint16_t command=u16(data+offset),count=command&32767;offset+=2;
      if(!count||index+count>16384)return false;
      bool repeat=command&32768;
      if(offset+(repeat?2:count*2)>size)return false;
      uint16_t color=repeat?u16(data+offset):0;
      for(uint16_t i=0;i<count;i++,index++){
        size_t target=mirrored?(index/128)*128+127-index%128:index;
        pixels[target]=repeat?color:u16(data+offset+i*2);
      }
      offset+=repeat?2:count*2;
    }
    if(index!=16384)return false;
    dirty=true;ready=true;return true;
  }
public:
  bool begin(websockets::WebsocketsClient* ws){
    socket=ws;
    encoded=static_cast<uint8_t*>(heap_caps_malloc(40000,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    pixels=static_cast<uint16_t*>(heap_caps_malloc(32768,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    return encoded&&pixels;
  }
  bool handleJson(JsonObjectConst p){
    if(strcmp(p["type"]|"","avatar.frame"))return false;
    sequence=p["seq"]|0U;expected=p["bytes"]|0U;received=0;
    if(!encoded||!pixels||!sequence||expected<4||expected>40000||(p["width"]|0)!=128||(p["height"]|0)!=128){expected=0;ack(false);return true;}
    flip=(p["flip"]|false) != bool(DSH_AVATAR_MIRROR);return true;
  }
  // Explicit envelope: kind 1 = image; kind 2 = PCM. Never infer from PCM contents.
  static bool unwrap(const char* input,size_t size,uint8_t& kind,const uint8_t*& payload,size_t& length,uint32_t& seq,uint32_t& offset){
    const uint8_t* p=reinterpret_cast<const uint8_t*>(input);
    if(size<17||memcmp(p,"DFTV",4)||p[4]!=1||(p[5]!=1&&p[5]!=2))return false;
    length=u16(p+6);if(!length||length>1024||length+16!=size)return false;
    kind=p[5];seq=u32(p+8);offset=u32(p+12);payload=p+16;return true;
  }
  void chunk(const uint8_t* data,size_t size,uint32_t seq,uint32_t offset){
    if(!expected||seq!=sequence||offset!=received||received+size>expected){expected=0;ack(false);return;}
    memcpy(encoded+received,data,size);received+=size;
    if(received==expected){bool ok=decode(encoded,expected,flip);expected=0;if(ok){lastRemote=millis();lastFallback=UINT32_MAX;}ack(ok);}
  }
  void tick(uint8_t emotion){
    if(lastRemote&&millis()-lastRemote<3000)return;
    if(emotion>=6)emotion=0;
    const auto& pose=DshTvArt::poses[emotion];
    uint16_t index=pose.first+(millis()/125)%pose.count;
    if(index==lastFallback)return;
    const auto& frame=DshTvArt::frames[index];
    if(decode(frame.bytes,frame.length,bool(DSH_AVATAR_MIRROR)))lastFallback=index;
  }
  bool needsDraw()const{return dirty;}
  void draw(TFT_eSprite& tft){if(ready){tft.setSwapBytes(true);tft.pushImage(56,28,128,128,pixels);tft.setSwapBytes(false);}dirty=false;}
};
