# 大肥鱼 · 朋友配置版

打开 [朋友配置.html](朋友配置.html)，选择**朋友电脑的系统**和已组装的设备，再逐段复制到那台电脑上的 DSH Agent。先验收桌宠和 NapCat QQ，再开网页。项目也可以单独在电脑上使用。

| 电脑 | 项目目录 | 启动 |
|---|---|---|
| Windows | `D:\dsh-tv` | 双击 `start-windows.cmd` |
| macOS | `~/dsh-tv` | 双击 `start-macos.command`，或在终端运行它 |

需要 Node.js **24.9 或更新版本**。启动入口会安装仓库锁定的依赖并初始化 `data/local.json`。填好 DeepSeek API Key 后再次启动。桌宠使用 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的透明桌面窗口，首次启动可能需要下载 Electron。聊天由独立的 DeepSeek Harness 会话处理，窗口最小化后服务照常运行。

```sh
npm ci
npm --prefix desktop ci
npm run init
npm run doctor
npm run doctor -- --live
npm start
```

`doctor -- --live` 会发出一条真实 DeepSeek 测试消息。网页初次监听 `http://127.0.0.1:18443`，访问码在 `data/local.json` 的 `web.password`。按教程配置局域网 HTTPS 后，用启动窗口给出的地址在手机浏览器打开。

- **QQ** 使用 [NapCat Shell](https://napneko.github.io/guide/boot/Shell.html) 的正向 OneBot v11 WebSocket。填好主人 QQ、机器人 QQ、地址和令牌。收到的主人私聊文字与网页共享会话，回复原路发回。
- **语音** 在火山引擎开通豆包流式语音识别 2.0 和语音合成 2.0。填入密钥和已开通的音色。网页录音和 V2 按键录音都会进入原会话，并收到文字及合成语音。
- **图片** 网页支持 PNG、JPEG、GIF 和 WebP，默认 DeepSeek Flash 可读图。把希望大肥鱼能发出的已有图片放在 `data/reply-images`，例如仓库的 `assets/desktop/DSniang1.png`。
- **设备** V1 和 V2 固件同仓库提供，支持 45° 直视屏或棱镜。用 `npm run firmware -- <版本> data/wifi.local.json` 生成联网配置，按教程用 PlatformIO 烧录。棱镜校准同时作用于角色、字幕和状态栏。

备份或迁移时先停止程序，再复制项目的整个 `data` 目录。SQLite 保存共同历史和媒体附件，`dsh-home` 保存模型上下文，`persona.txt` 是大肥鱼的人设。编辑人设后重启即可。Wi-Fi 和电脑配对令牌保存在本机生成的固件头文件。详见[素材说明](assets/NOTICES.md)。

运行 `npm test` 验证聊天路由、存储、媒体与硬件协议。真实 QQ 扫码、云服务密钥、桌面交互、棱镜和按键语音需要在目标机器及设备验收。
