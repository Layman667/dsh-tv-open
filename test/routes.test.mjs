import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { Store } from '../app/store.mjs';
import { Chat } from '../app/chat.mjs';
import { NapCat } from '../app/napcat.mjs';
import { startWeb } from '../app/web.mjs';
import { startBridge } from '../pc-bridge/lib/bridge.mjs';
import { deviceConfig } from '../app/config.mjs';

async function until(fn) {
  for (let i = 0; i < 300; i++) {
    const value = fn();
    if (value) return value;
    await delay(10);
  }
  assert.fail('Timed out');
}

test('QQ, LAN chat and V2 use one queue, return replies to the source and keep media after restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-tv-open-test-'));
  const file = path.join(dir, 'chat.sqlite');
  const images = path.join(dir, 'reply-images');
  await mkdir(images);
  const png = await readFile(new URL('../assets/desktop/DSniang1.png', import.meta.url));
  await writeFile(path.join(images, 'whale.png'), png);
  const store = new Store(file);
  const input = [];
  const pcm = Buffer.alloc(16000, 11);
  const config = {
    web: { host: '127.0.0.1', port: 0, password: 'test-pass-only' },
    voice: { enabled: true },
    device: { host: '127.0.0.1', port: 0, token: 'test-device-token-only' }
  };
  const bridgeConfig = deviceConfig(config);
  let bridge;
  const chat = new Chat({
    store, dataDir: dir, log: () => {},
    model: {
      async ask(text, image) {
        if (text === '你看到了什么') assert.deepEqual(image?.bytes, png);
        input.push(text);
        return text === '你看到了什么' ? '看到了大肥鱼。\n[图片:whale.png]' : '暗号是蓝鲸。';
      },
      async close() {}
    },
    voice: {
      async recognize(bytes) { assert.deepEqual(bytes, pcm); return '网页语音'; },
      async synthesize() { return pcm; }
    },
    onMessage: message => bridge?.broadcast(message)
  });
  bridge = await startBridge(bridgeConfig, { log: () => {}, voiceProviders: {
    readKeys: async () => ({}),
    recognize: async () => '设备语音',
    ask: (text, _config, _signal, { pcm }) => chat.submit({
      source: 'v2', requestKey: 'v2:test', text, pcm, wantAudio: true
    }).done
  } });
  const web = await startWeb(config, { store, chat });
  const bot = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(bot, 'listening');
  const onebot = [];
  bot.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    socket.on('message', raw => {
      const { action, params, echo } = JSON.parse(raw);
      if (action === 'send_private_msg') onebot.push(params);
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: 5678 } }));
    });
  });
  const napcat = new NapCat({
    enabled: true, owner: '1234', bot: '5678',
    url: `ws://127.0.0.1:${bot.address().port}`, token: 'test-token'
  }, chat, () => {});
  t.after(async () => {
    napcat.stop();
    await web.close();
    await bridge.stop();
    for (const client of bot.clients) client.terminate();
    await new Promise(resolve => bot.close(resolve));
    await chat.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  napcat.start();
  await until(() => napcat.ready);
  const event = { post_type: 'message', message_type: 'private', self_id: 5678, user_id: 1234,
    message_id: 1, message: [{ type: 'text', data: { text: '记住暗号蓝鲸' } }] };
  const [qq] = bot.clients;
  qq.send(JSON.stringify({ ...event, user_id: 9999 }));
  qq.send(JSON.stringify(event));
  qq.send(JSON.stringify(event));
  await until(() => onebot.length);
  assert.deepEqual(input, ['记住暗号蓝鲸']);
  assert.deepEqual(onebot[0], { user_id: 1234, message: [{ type: 'text', data: { text: '暗号是蓝鲸。' } }] });

  assert.equal((await fetch(web.url + '/api/history')).status, 401);
  const post = (route, body, cookie, origin = web.url) => fetch(web.url + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  const auth = await post('/api/login', { password: config.web.password });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const photo = { id: '1261b0f1-5291-4b5f-924c-e8af1f90bbb0', text: '你看到了什么', image: png.toString('base64') };
  assert.equal((await post('/api/messages', photo, cookie, 'https://other.example')).status, 403);
  const photoResult = await post('/api/messages', photo, cookie);
  assert.equal(photoResult.status, 202);
  assert.deepEqual(await (await post('/api/messages', photo, cookie)).json(), await photoResult.json());
  const sound = await post('/api/messages', { id: '1261b0f1-5291-4b5f-924c-e8af1f90bbb1', pcm: pcm.toString('base64') }, cookie);
  assert.equal(sound.status, 202);
  await until(() => store.history().some(msg => msg.role === 'assistant' && msg.audio));
  assert.deepEqual(input, ['记住暗号蓝鲸', '你看到了什么', '网页语音']);
  assert.equal(onebot.length, 1);

  const media = store.history().find(msg => msg.role === 'assistant' && msg.image).image;
  const imageResponse = await fetch(web.url + '/api/media/' + media, { headers: { Cookie: cookie } });
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.address.port}/`, { headers: { 'X-Pair-Token': config.device.token } });
  const send = (type, extra) => ws.send(JSON.stringify({ type, id: 'record', ...extra }));
  const received = [];
  let played = 0;
  ws.on('message', (raw, binary) => {
    if (binary) {
      played += raw.length;
      send('voice.play.ack', { received: played });
      return;
    }
    const message = JSON.parse(raw);
    received.push(message);
    if (message.type === 'voice.config') send('voice.begin', { format: 'pcm_s16le', sampleRate: 16000, channels: 1, bytes: pcm.length });
    if (message.type === 'voice.upload.ready') {
      for (let n = 0; n < pcm.length; n += 1024) ws.send(pcm.subarray(n, n + 1024));
      send('voice.end', { bytes: pcm.length });
    }
    if (message.type === 'voice.play.start') send('voice.play.ready', { capacity: pcm.length });
    if (message.type === 'voice.play.end') send('voice.play.done', { playedBytes: played });
  });
  await once(ws, 'open');
  send('device.status', { voiceVersion: 2 });
  await until(() => received.some(msg => msg.type === 'voice.done'));
  assert.equal(played, pcm.length);
  assert.equal(onebot.length, 1);
  ws.terminate();
  await until(() => bridge.wss.clients.size === 0);
  assert.equal((await fetch(web.url + '/api/history', { headers: { Cookie: cookie } })).status, 200);
  qq.send(JSON.stringify({ ...event, message_id: 2 }));
  await until(() => onebot.length === 2);

  const reopened = new Store(file);
  assert.deepEqual(reopened.history().map(msg => msg.source), ['qq', 'qq', 'web', 'web', 'web', 'web', 'v2', 'v2', 'qq', 'qq']);
  assert.deepEqual(Buffer.from(reopened.getMedia(media).bytes), png);
  reopened.close();
});
