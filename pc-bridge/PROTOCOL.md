# ESP32 V2 局域网语音协议

连接沿用 `ws://电脑IPv4:18765/`，握手头 `X-Pair-Token`。V1 文字事件保持原格式；V2 在 `device.status` 中增加 `voiceVersion: 2`，电脑回复 `voice.config`（语音开关、录音 / 播放上限、回放测试标志）。不传输云端 Key 或 DSH 桌宠令牌。

一次全局只处理一个设备语音轮次。所有语音 JSON 都带该轮 `id`（1–48 位字母 / 数字 / 下划线 / 连字符）。音频固定为有符号 16-bit 小端、16kHz、单声道裸 PCM；I²S 的 32-bit 立体声槽位转换由固件完成。

## 上传

1. 设备本地录音完成后发送：`{"type":"voice.begin","id":"abc","format":"pcm_s16le","sampleRate":16000,"channels":1,"bytes":9600}`。
2. 电脑验证设备能力、开关、全局占用与长度，返回 `voice.upload.ready`。
3. 每帧发送最多 1024 字节偶数长度的二进制；电脑回 `voice.upload.ack`，`received` 是累计字节数。设备收到准确累计数后才能继续。
4. 上传总数等于声明值后，设备发送 `voice.end`（带 bytes），电脑才开始识别。录音 0.25–15 秒，上传超时 30 秒，不足 / 超限 / 错序取消。

电脑依次推送 `voice.state`：asr / dsh / tts / receiving / playing；`voice.transcript.text` 只用于小屏短文字。识别全文在电脑进入原 DSH 主人会话，不另开模型会话。

## 下发与播放

1. 电脑取得完整且正常结束的 PCM 后，发送 `voice.play.start`（带 format / sampleRate / channels / bytes）。
2. 设备确认状态、格式和 PSRAM 容量，回复 `voice.play.ready`，带 capacity。
3. 电脑逐个发送 ≤1024 字节二进制帧，设备回 `voice.play.ack.received`；每次等待正确累计数后继续，无确认不继续堆积。
4. 电脑发送 `voice.play.end`（bytes），设备确认完整收包后才播放，期间不收音。
5. 设备在 I²S 输出和尾部静音排空后发送 `voice.play.done`（playedBytes）；电脑检查总数，再发 `voice.done` 结束该轮。

单次音频最大90秒 / 2,880,000字节，单包 ACK 超时5秒，播放完成超时按音频时长加15秒。V2 固件固定预分配 PSRAM 缓冲，不边收边无界申请。

## 取消与原上下文

`voice.cancel` / `voice.error` / WebSocket 断开会中止在途音频、云请求和等待；旧轮次结果不能向新轮次发送。已经交给共同会话的轮次会继续保存，设备重连后可以查看后续新回复。

语音转写进入电脑端共用队列。QQ、网页和 V2 使用同一个 DSH SDK 会话。V2 的文字、原录音和合成音频写入本地历史，文字同步到显示设备，音频只下发给发起按键录音的 V2。

正常 QQ 文本只广播文字，不触发 TTS。`audio-demo` 仅将上传 PCM 回放，不读云密钥、不发送 DSH / QQ 输入。

## v2.1 图像与语音下行复用

新 V1 / V2 在 device.status 中声明 avatarVersion:1、binaryEnvelope:1。V2 同时声明 voiceVersion:2。只有声明两项图像能力的设备才接收图像；旧 V2 继续接收原始 PCM（原有自动测试保留）。新固件需要本版电脑桥接；不要用旧桥接给新 V2 下发无封装 PCM。

二进制下行包头 16 字节（数值均小端）：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | ASCII DFTV |
| 4 | 1 | 版本 1 |
| 5 | 1 | 类型：1 = RLE 图像；2 = PCM |
| 6 | 2 | 本包负载长度 1–1024 |
| 8 | 4 | 图像 seq；PCM 为 0 |
| 12 | 4 | 本帧 RLE 字节偏移；PCM 为 0 |
| 16 | 可变 | 数据负载 |

JSON avatar.frame 先声明 seq、bytes（≤40000）、width/height（均128）、flip、live、asset、frame。随后按偏移发送同 seq 的类型 1 包。固件收齐并成功解码后回复 avatar.ack {seq,ok:true}；失败回复 false。每台设备最多一个未确认帧，ACK 前跳过新帧，5 秒未确认断开重连。静态画面约每秒重发，保持设备不误判失联。图像包与类型 2 PCM 可交错；PCM ACK 仍只计算负载字节。上行录音保持原始 PCM，仅在已声明语音上传的会话内接受。

RLE 命令为 uint16：低15位是像素数（不可0）；高位1表示重复后面的1个RGB565像素，高位0表示紧随对应数量像素。RGB565像素小端，解码必须恰为128×128，无越界、截断或尾随数据。

电脑 .dfa 文件：16字节头 DFA1、uint16宽、高、fps、帧数、uint32时长毫秒；后面每帧 uint32绝对偏移+uint32 RLE长度，再接帧数据。manifest SHA256用于启动按需载入校验；缓存最多3个动作。

桌宠传感器每50ms观察实际可见视频 / 表情，动作变化立刻上报；视频状态约250ms、静态约1000ms心跳。POST /dsh-whale/tv-visual.json 仍由上游信任栅栏包裹，另限本机回环、JSON、同源Origin（兼容上游已鉴权的本机 Electron Origin:null，仍拒绝 cross-site）、4KB上限和视觉字段白名单。写 host.json 相邻状态文件；不增加 DSH 的 LAN 暴露端口。
