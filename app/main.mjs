import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, deviceConfig, voiceKeys } from './config.mjs';
import { DshModel } from './model.mjs';
import { Chat } from './chat.mjs';
import { Store } from './store.mjs';
import { Pet } from './pet.mjs';
import { NapCat } from './napcat.mjs';
import { startWeb } from './web.mjs';
import { startBridge } from '../pc-bridge/lib/bridge.mjs';
import { recognizePcm, synthesizePcm } from '../pc-bridge/lib/doubao.mjs';

async function main() {
  const config = await loadConfig();
  if (!config.deepseek.apiKey) throw new Error('先运行 npm run init，再填写 data/local.json 的 deepseek.apiKey');
  const voiceConfig = deviceConfig(config);
  const keys = voiceKeys(config);
  const voice = {
    recognize: pcm => recognizePcm(pcm, voiceConfig, keys),
    synthesize: text => synthesizePcm([...text].slice(0, voiceConfig.voice.maxSpeakChars).join(''), voiceConfig, keys)
  };

  const handlers = {};
  const web = await startWeb(config, handlers);
  let device, pet, chat, napcat, store;
  async function close() {
    napcat?.stop();
    await web.close();
    await device?.stop();
    await chat?.stop();
    await pet?.stop();
    store?.close();
  }
  try {
    store = new Store(path.join(config.dataDir, 'chat.sqlite'));
    store.recover();
    handlers.store = store;
    pet = new Pet(config);
    await pet.start().catch(error => console.error('[桌宠]', error.message));
    chat = new Chat({
      store,
      model: new DshModel(config, store),
      dataDir: config.dataDir,
      voice,
      onMessage: message => device?.broadcast(message),
      onState: (state, text) => {
        pet.state(state, text);
        device?.avatar.observe({ type: 'chat.state', state });
      }
    });
    handlers.chat = chat;

    if (config.device.enabled) {
      device = await startBridge(voiceConfig, {
        readVisual: () => pet.visual(),
        voiceProviders: {
          readKeys: async () => keys,
          ask: async (text, _config, signal, { pcm }) => {
            signal.throwIfAborted();
            return chat.submit({
              requestKey: 'v2:' + randomUUID(), source: 'v2', text, pcm, wantAudio: true
            }).done;
          }
        }
      }).catch(error => {
        console.error('[设备] 启动失败，请检查地址或端口。', error.code || error.message);
        return null;
      });
    }
    napcat = new NapCat(config.qq, chat);
    napcat.start();

    console.log(`[网页] ${web.url}`);
    console.log(`[数据] ${config.dataDir}`);
    if (device) console.log(`[设备] ws://${config.device.host}:${device.address.port}/`);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      close().catch(error => {
        console.error('停止服务失败：', error.message);
        process.exitCode = 1;
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
