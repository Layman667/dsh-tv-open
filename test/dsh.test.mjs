import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DshModel } from '../app/model.mjs';
import { Store } from '../app/store.mjs';

test('released DSH SDK sends images and restores the same conversation after process restart', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-tv-sdk-'));
  const requests = [];
  let imageUploaded = false;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
      return;
    }
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks);
    if (req.url.endsWith('/files')) {
      imageUploaded = body.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'file_fixture', object: 'file', bytes: body.length, filename: 'image.png', purpose: 'vision' }));
      return;
    }
    requests.push(JSON.parse(body.toString()));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
    emit('message_start', { message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '暗号是蓝鲸。' } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
    emit('message_stop', {});
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const original = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(dir, 'persona.txt'), '测试用大肥鱼人设');
  const config = { dataDir: dir, deepseek: { model: 'deepseek-flash', apiKey: 'fixture-key-only' } };
  const dbPath = path.join(dir, 'chat.sqlite');
  let store = new Store(dbPath);
  let model = new DshModel(config, store);
  t.after(async () => {
    if (original === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = original;
    await model.close();
    store.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(await model.ask('请记住暗号蓝鲸', null, []), '暗号是蓝鲸。');
  assert.match(JSON.stringify(requests[0].system), /测试用大肥鱼人设/);
  assert.equal(requests[0].tools?.length ?? 0, 0);
  const id = store.getSetting('dsh-session');
  assert.ok(id);
  await model.close();
  store.close();
  store = new Store(dbPath);
  model = new DshModel(config, store);
  const png = await readFile(new URL('../assets/desktop/DSniang1.png', import.meta.url));
  assert.equal(await model.ask('图里是谁？', { mime: 'image/png', bytes: png }, []), '暗号是蓝鲸。');
  assert.equal(store.getSetting('dsh-session'), id);
  const second = requests.at(-1);
  assert.match(JSON.stringify(second.messages), /请记住暗号蓝鲸/);
  assert.equal(imageUploaded, true);
  assert.ok(second.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image')));
});
