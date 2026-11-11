#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <TFT_eSPI.h>
#include <U8g2_for_TFT_eSPI.h>
#include "avatar_player.h"

#if __has_include("user_config.h")
#include "user_config.h"
#else
#include "user_config.h.example"
#endif

#include "voice_device.h"

using namespace websockets;

#ifndef DSH_BACKLIGHT_PIN
// The selected 7-pin panel uses a separately powered, always-on backlight.
#define DSH_BACKLIGHT_PIN -1
#endif

// Full GB2312 Chinese glyph set is provided by the U8g2 dependency.
// The TFT adapter uses its UTF-8 renderer to draw the font in color.
static const uint8_t *const CJK_FONT = u8g2_font_wqy12_t_gb2312b;

namespace {

constexpr uint16_t SCREEN_W = 240;
constexpr uint16_t SCREEN_H = 240;
constexpr uint16_t COLOR_BG = TFT_BLACK;
constexpr uint16_t COLOR_TEXT = TFT_WHITE;
constexpr uint16_t COLOR_MUTED = 0x7BEF;
constexpr uint16_t COLOR_BUBBLE = 0x10A2;
constexpr uint32_t WIFI_RETRY_MS = 10000;
constexpr uint32_t WS_STATUS_INTERVAL_MS = 20000;
constexpr size_t REPLY_MAX_BYTES = 360;

enum class Emotion : uint8_t {
  Idle,
  Happy,
  Thinking,
  Listening,
  Sad,
  Confused
};

#ifndef DSH_TFT_ROTATION
#define DSH_TFT_ROTATION 0
#endif
#ifndef DSH_SCREEN_MIRROR
#define DSH_SCREEN_MIRROR 0
#endif

TFT_eSPI panel;
TFT_eSprite tft(&panel);
U8g2_for_TFT_eSPI cjk;
WebsocketsClient ws;
AvatarPlayer avatar;
VoiceDevice voice;

Emotion currentEmotion = Emotion::Idle;
char currentReply[REPLY_MAX_BYTES + 1] = "大肥鱼准备好了";
bool wsOnline = false;
bool wsCallbacksReady = false;
bool wifiConfigMissing = false;
uint32_t nextWifiRetryAt = 0;
uint32_t nextWsRetryAt = 0;
uint32_t wsRetryDelayMs = 2000;
uint32_t lastStatusSentAt = 0;
uint32_t lastScreenDrawAt = 0;
bool screenDirty = true;

uint8_t utf8CharBytes(uint8_t lead) {
  if ((lead & 0x80) == 0) return 1;
  if ((lead & 0xE0) == 0xC0) return 2;
  if ((lead & 0xF0) == 0xE0) return 3;
  if ((lead & 0xF8) == 0xF0) return 4;
  return 1;
}

void copyUtf8Limited(char *out, size_t outSize, const char *input) {
  if (outSize == 0) return;
  out[0] = '\0';
  if (input == nullptr) return;

  size_t written = 0;
  const auto *p = reinterpret_cast<const uint8_t *>(input);
  while (*p != 0) {
    const uint8_t count = utf8CharBytes(*p);
    bool complete = true;
    for (uint8_t i = 1; i < count; ++i) {
      if (p[i] == 0 || (p[i] & 0xC0) != 0x80) {
        complete = false;
        break;
      }
    }
    const uint8_t safeCount = complete ? count : 1;
    if (written + safeCount >= outSize) break;
    for (uint8_t i = 0; i < safeCount; ++i) out[written++] = static_cast<char>(p[i]);
    p += safeCount;
  }
  out[written] = '\0';
}

Emotion parseEmotion(const char *value) {
  if (value == nullptr) return Emotion::Idle;
  if (strcmp(value, "happy") == 0 || strcmp(value, "开心") == 0) return Emotion::Happy;
  if (strcmp(value, "thinking") == 0 || strcmp(value, "思考") == 0) return Emotion::Thinking;
  if (strcmp(value, "listening") == 0 || strcmp(value, "聆听") == 0) return Emotion::Listening;
  if (strcmp(value, "sad") == 0 || strcmp(value, "难过") == 0) return Emotion::Sad;
  if (strcmp(value, "confused") == 0 || strcmp(value, "困惑") == 0) return Emotion::Confused;
  return Emotion::Idle;
}


void appendGlyph(char *line, size_t lineSize, const char *glyph, size_t glyphBytes) {
  const size_t used = strlen(line);
  if (used + glyphBytes >= lineSize) return;
  memcpy(line + used, glyph, glyphBytes);
  line[used + glyphBytes] = '\0';
}

void scheduleWebsocketRetry() {
  nextWsRetryAt = millis() + wsRetryDelayMs;
  wsRetryDelayMs = wsRetryDelayMs < 28000 ? wsRetryDelayMs + 2000 : 30000;
}

void wrapReply(const char *input, char (&line1)[96], char (&line2)[96]) {
  line1[0] = '\0';
  line2[0] = '\0';
  char *lines[] = {line1, line2};
  uint8_t row = 0;
  const char *p = input;

  while (*p != '\0' && row < 2) {
    if (*p == '\r') {
      ++p;
      continue;
    }
    if (*p == '\n') {
      ++row;
      ++p;
      continue;
    }

    const uint8_t glyphBytes = utf8CharBytes(static_cast<uint8_t>(*p));
    char glyph[5] = {0, 0, 0, 0, 0};
    memcpy(glyph, p, glyphBytes);
    char candidate[100];
    snprintf(candidate, sizeof(candidate), "%s%s", lines[row], glyph);

    if (cjk.getUTF8Width(candidate) > 208 && lines[row][0] != '\0') {
      ++row;
      continue;
    }

    appendGlyph(lines[row], sizeof(line1), glyph, glyphBytes);
    p += glyphBytes;
  }
}

void drawStatusBar() {
  tft.fillRect(0, 0, SCREEN_W, 27, 0x0841);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_TEXT, 0x0841);
  tft.setCursor(9, 7);
  tft.print("DFY");

  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  const uint16_t wifiColor = wifiUp ? TFT_GREEN : TFT_RED;
  tft.fillCircle(63, 13, 4, wifiColor);
  tft.setTextFont(1);
  tft.setTextColor(wifiUp ? COLOR_TEXT : COLOR_MUTED, 0x0841);
  tft.setCursor(72, 9);
  tft.print(wifiUp ? "WIFI" : (wifiConfigMissing ? "SET WIFI" : "NO WIFI"));

  const uint16_t pcColor = wsOnline ? TFT_GREEN : TFT_ORANGE;
  tft.fillCircle(161, 13, 4, pcColor);
  tft.setTextColor(COLOR_TEXT, 0x0841);
  tft.setCursor(170, 9);
  tft.print(wsOnline ? "PC LINK" : (DSH_DEMO_MODE ? "DEMO" : "WAIT PC"));
}

void presentScreen() {
#if DSH_SCREEN_MIRROR == 0
  tft.pushSprite(0, 0);
#else
  const auto* pixels = static_cast<const uint16_t*>(tft.getPointer());
  uint16_t line[SCREEN_W];
  panel.setSwapBytes(false);
  panel.startWrite();
  for (int y = 0; y < SCREEN_H; ++y) {
    const int sourceY = DSH_SCREEN_MIRROR == 2 ? SCREEN_H - 1 - y : y;
    const uint16_t* row = pixels + sourceY * SCREEN_W;
    if (DSH_SCREEN_MIRROR == 1) {
      for (int x = 0; x < SCREEN_W; ++x) line[x] = row[SCREEN_W - 1 - x];
    } else {
      memcpy(line, row, sizeof(line));
    }
    panel.pushImage(0, y, SCREEN_W, 1, line);
  }
  panel.endWrite();
#endif
}

void drawScreen() {
  tft.fillScreen(COLOR_BG);
  drawStatusBar();

  tft.setTextFont(1);
  tft.setTextColor(COLOR_MUTED, COLOR_BG);
  tft.setCursor(12, 164);
  cjk.setForegroundColor(COLOR_MUTED);
  cjk.drawUTF8(12, 171, voice.caption());

  avatar.draw(tft);
  tft.drawRoundRect(8, 175, 224, 53, 10, COLOR_BUBBLE);
  tft.fillRoundRect(9, 176, 222, 51, 9, COLOR_BG);

  char line1[96];
  char line2[96];
  wrapReply(currentReply, line1, line2);
  cjk.setFontMode(1);
  cjk.setFont(CJK_FONT);
  cjk.setForegroundColor(COLOR_TEXT);
  cjk.drawUTF8(15, 196, line1);
  cjk.drawUTF8(15, 218, line2);

  if (strlen(line1) == 0 && strlen(line2) == 0) {
    cjk.drawUTF8(15, 196, "等你发来下一句话");
  }

  cjk.setForegroundColor(COLOR_MUTED);
  cjk.drawUTF8(75, 239, "完整记录看网页");

  screenDirty = false;
  lastScreenDrawAt = millis();
  presentScreen();
}

void sendDeviceStatus() {
  if (!ws.available()) return;

  StaticJsonDocument<384> status;
  status["type"] = "device.status";
  status["state"] = "online";
  status["avatarVersion"] = 1;
  status["binaryEnvelope"] = 1;
  status["firmware"] = "dsh-dfy-esp32-v2";
  status["voiceVersion"] = 2;
  status["wifi_rssi"] = WiFi.RSSI();

  char packet[384];
  const size_t bytes = serializeJson(status, packet, sizeof(packet));
  if (bytes > 0) {
    ws.send(packet);
    lastStatusSentAt = millis();
  }
}

void handlePacket(const String &payload) {
  StaticJsonDocument<1024> doc;
  const DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("[WS] JSON parse failed: %s\n", error.c_str());
    return;
  }

  if (avatar.handleJson(doc.as<JsonObjectConst>())) return;
  const char *type = doc["type"] | "";
  const char *text = doc["text"] | "";
  const char *emotion = doc["emotion"] | "idle";

  const bool currentVoicePacket=voice.matchesId(doc["id"] | "");
  if (voice.handleJson(doc.as<JsonObjectConst>())) {
    if (currentVoicePacket && (strcmp(type,"voice.transcript")==0 || strcmp(type,"voice.error")==0)) {
      copyUtf8Limited(currentReply,sizeof(currentReply),strcmp(type,"voice.error")==0 ? (doc["message"] | "语音失败") : text);
    }
    screenDirty=true;
    return;
  }

  if (strcmp(type, "chat.reply") == 0) {
    copyUtf8Limited(currentReply, sizeof(currentReply), text);
    currentEmotion = parseEmotion(emotion);
    screenDirty = true;
    Serial.printf("[WS] reply (%u bytes)\n", static_cast<unsigned>(strlen(currentReply)));
  } else if (strcmp(type, "chat.user") == 0) {
    copyUtf8Limited(currentReply, sizeof(currentReply), text);
    currentEmotion = Emotion::Listening;
    screenDirty = true;
  } else if (strcmp(type, "chat.state") == 0) {
    currentEmotion = parseEmotion(emotion);
    screenDirty = true;
  } else if (strcmp(type, "server.status") == 0) {
    const bool qqReady = doc["qq"] | false;
    const bool dshReady = doc["dsh"] | false;
    if (!dshReady || !qqReady) currentEmotion = Emotion::Thinking;
    screenDirty = true;
  }
}

void setupWebsocketCallbacks() {
  if (wsCallbacksReady) return;
  ws.addHeader("X-Pair-Token", PAIR_TOKEN);
  ws.onMessage([](WebsocketsMessage message) {
    if (message.isText()) handlePacket(message.data());
    else if (message.isBinary()) {
      const auto raw = message.rawData();
      uint8_t kind;const uint8_t* payload;size_t length;uint32_t seq,offset;
      if(AvatarPlayer::unwrap(raw.data(),raw.size(),kind,payload,length,seq,offset)){
        if(kind==1)avatar.chunk(payload,length,seq,offset);
        else if(kind==2)voice.handleBinary(reinterpret_cast<const char*>(payload),length);
      }
    }
  });
  ws.onEvent([](WebsocketsEvent event, String data) {
    if (event == WebsocketsEvent::ConnectionOpened) {
      wsOnline = true;
      wsRetryDelayMs = 2000;
      nextWsRetryAt = millis() + wsRetryDelayMs;
      Serial.println("[WS] connected to PC bridge");
      sendDeviceStatus();
      screenDirty = true;
    } else if (event == WebsocketsEvent::ConnectionClosed) {
      wsOnline = false;
      scheduleWebsocketRetry();
      Serial.println("[WS] connection closed");
      screenDirty = true;
    }
  });
  wsCallbacksReady = true;
}

bool wifiCredentialsPresent() {
  return WIFI_SSID[0] != '\0' && strcmp(WIFI_SSID, "填家里的2.4GHz Wi-Fi名称") != 0;
}

void startWifi() {
  if (!wifiCredentialsPresent()) {
    wifiConfigMissing = true;
    Serial.println("[WiFi] set WIFI_SSID and WIFI_PASSWORD in user_config.h");
    screenDirty = true;
    return;
  }
  wifiConfigMissing = false;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  nextWifiRetryAt = millis() + WIFI_RETRY_MS;
  Serial.printf("[WiFi] connecting to %s\n", WIFI_SSID);
}

void tryConnectWebsocket() {
  if (WiFi.status() != WL_CONNECTED || !wifiCredentialsPresent()) return;
  if (ws.available()) return;
  if (static_cast<int32_t>(millis() - nextWsRetryAt) < 0) return;

  char url[160];
  snprintf(url, sizeof(url), "ws://%s:%u%s", PC_HOST, PC_PORT, PC_WS_PATH);
  Serial.printf("[WS] connecting to %s\n", url);
  if (!ws.connect(url)) {
    wsOnline = false;
    scheduleWebsocketRetry();
    screenDirty = true;
    Serial.println("[WS] failed; will retry");
  }
}

void drawDemoFrame() {
  static const char *messages[] = {
    "你好呀，今天也要开心！",
    "我在这里陪你聊天。",
    "收到消息啦，正在想一想。",
    "先把屏幕和表情调好吧。"
  };
  static const Emotion emotions[] = {
    Emotion::Happy, Emotion::Idle, Emotion::Thinking, Emotion::Listening
  };
  static uint8_t index = 0;
  static uint32_t nextDemoAt = 0;

  if (static_cast<int32_t>(millis() - nextDemoAt) >= 0) {
    copyUtf8Limited(currentReply, sizeof(currentReply), messages[index]);
    currentEmotion = emotions[index];
    index = (index + 1) % 4;
    nextDemoAt = millis() + 3500;
    screenDirty = true;
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(150);

#if DSH_BACKLIGHT_PIN >= 0
  pinMode(DSH_BACKLIGHT_PIN, OUTPUT);
  digitalWrite(DSH_BACKLIGHT_PIN, HIGH);
#endif
  panel.init();
  panel.setRotation(DSH_TFT_ROTATION);
  panel.invertDisplay(DSH_TFT_INVERTED);
  tft.setColorDepth(16);
  if (!tft.createSprite(SCREEN_W, SCREEN_H)) {
    Serial.println("TFT framebuffer allocation failed");
    for (;;) delay(1000);
  }
  if(!avatar.begin(&ws)) Serial.println("[ART] PSRAM allocation failed");
  avatar.tick(0);
  cjk.begin(tft);
  cjk.setFont(CJK_FONT);
  cjk.setFontMode(1);

  Serial.println();
  Serial.println("大肥鱼 ESP32 V2 boot");
  if (!voice.begin(&ws)) Serial.println("[AUDIO] init failed; check PSRAM config and I2S hardware");
  Serial.printf("Free heap: %lu bytes\n", static_cast<unsigned long>(ESP.getFreeHeap()));

  currentReply[0] = '\0';
  if (DSH_DEMO_MODE) {
    Serial.println("[MODE] screen demo; no PC bridge needed");
  } else {
    setupWebsocketCallbacks();
    startWifi();
  }
  screenDirty = true;
  drawScreen();
}

void loop() {
  const uint32_t now = millis();

  if (DSH_DEMO_MODE) {
    drawDemoFrame();
  } else {
    if (wifiCredentialsPresent() && WiFi.status() != WL_CONNECTED &&
        static_cast<int32_t>(now - nextWifiRetryAt) >= 0) {
      ws.close();
      wsOnline = false;
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      nextWifiRetryAt = now + WIFI_RETRY_MS;
      screenDirty = true;
    }

    if (WiFi.status() == WL_CONNECTED) {
      tryConnectWebsocket();
      if (ws.available()) {
        ws.poll();
      } else if (wsOnline) {
        wsOnline = false;
        screenDirty = true;
      }

      if (wsOnline && now - lastStatusSentAt >= WS_STATUS_INTERVAL_MS) {
        sendDeviceStatus();
      }
    }
  }

  voice.tick(wsOnline);
  static uint32_t lastVoiceRevision=0;
  if(lastVoiceRevision!=voice.revision()){lastVoiceRevision=voice.revision();screenDirty=true;}

  avatar.tick(static_cast<uint8_t>(currentEmotion));
  if (screenDirty || now - lastScreenDrawAt >= 15000) {
    drawScreen();
  } else if(avatar.needsDraw()) { avatar.draw(tft); presentScreen(); }
  delay(5);
}
