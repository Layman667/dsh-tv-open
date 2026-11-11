import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './config.mjs';
import { audioInput, picture } from './media.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/chat.css', ['chat.css', 'text/css; charset=utf-8']],
  ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/record.js', ['record.js', 'text/javascript; charset=utf-8']],
  ['/character.png', ['../assets/desktop/DSniang1.png', 'image/png']]
]);

const hash = value => createHash('sha256').update(value).digest();
const MAX_BODY = 12 * 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/i;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) throw new Error('文件太大');
  const parts = [];
  let total = 0;
  for await (const part of req) {
    total += part.length;
    if (total > maxBytes) throw new Error('文件太大');
    parts.push(part);
  }
  const value = JSON.parse(Buffer.concat(parts).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('消息格式无效');
  return value;
}

function base64(value, label) {
  if (typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error(`${label}编码无效`);
  return Buffer.from(value, 'base64');
}

export async function startWeb(config, handlers) {
  const { web } = config;
  const expected = hash(web.password);
  const session = randomBytes(32).toString('base64url');
  const tls = web.cert && web.key;
  const allowedHost = () => `${web.host}:${server.address()?.port ?? web.port}`;
  const httpProtocol = tls ? 'https' : 'http';
  const isSignedIn = req => (req.headers.cookie || '').split(';').some(x => x.trim() === `dsh_tv=${session}`);
  let rejected = 0;
  let retryAt = 0;

  const handle = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== allowedHost()) return json(res, 400, { error: '请使用启动时显示的地址' });
    const url = new URL(req.url, `${httpProtocol}://${allowedHost()}`);
    if (req.method === 'POST' && req.headers.origin !== `${httpProtocol}://${allowedHost()}`)
      return json(res, 403, { error: '请从聊天页提交' });

    const file = files.get(url.pathname);
    if (req.method === 'GET' && file) {
      const data = await readFile(path.join(root, 'web', file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      return res.end(data);
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (Date.now() < retryAt) return json(res, 429, { error: '尝试次数过多，等一分钟再试' });
      const input = await body(req, 2048);
      if (typeof input.password !== 'string' || !timingSafeEqual(hash(input.password), expected)) {
        if (++rejected >= 8) {
          retryAt = Date.now() + 60000;
          rejected = 0;
        }
        return json(res, 401, { error: '访问码有误' });
      }
      rejected = 0;
      res.setHeader('Set-Cookie', `dsh_tv=${session}; HttpOnly; SameSite=Strict; Path=/${tls ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }

    if (!handlers.store) return json(res, 503, { error: '聊天服务正在启动' });
    if (!isSignedIn(req)) return json(res, 401, { error: '请先登录' });
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const raw = url.searchParams.get('before');
      const before = raw === null ? undefined : Number(raw);
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        return json(res, 400, { error: '历史页码有误' });
      return json(res, 200, { messages: handlers.store.history(before), voice: config.voice.enabled });
    }

    const media = /^\/api\/media\/([a-f0-9-]{36})$/i.exec(url.pathname);
    if (['GET', 'HEAD'].includes(req.method) && media) {
      const value = handlers.store.getMedia(media[1]);
      if (!value) return json(res, 404, { error: '找不到附件' });
      const length = value.bytes.length;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', value.mime);
      if (range) {
        const first = Number(range[1]);
        const last = Math.min(length - 1, range[2] ? Number(range[2]) : length - 1);
        if (!Number.isSafeInteger(first) || first >= length || last < first) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + length });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${first}-${last}/${length}`,
          'Content-Length': last - first + 1
        });
        return res.end(req.method === 'HEAD' ? undefined : value.bytes.subarray(first, last + 1));
      }
      res.writeHead(200, { 'Content-Length': length });
      return res.end(req.method === 'HEAD' ? undefined : value.bytes);
    }

    if (req.method === 'POST' && url.pathname === '/api/messages') {
      if (!handlers.chat) return json(res, 503, { error: '聊天服务正在启动' });
      const input = await body(req, MAX_BODY);
      if (typeof input.id !== 'string' || !UUID.test(input.id)) throw new Error('消息编号无效');
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length > 12000) throw new Error('这条消息太长，请分开发送');
      const image = input.image ? picture(base64(input.image, '图片')) : null;
      const pcm = input.pcm ? audioInput(base64(input.pcm, '录音')) : null;
      if (!text && !image && !pcm) throw new Error('请写文字、录音或选图');
      if (pcm && (image || text)) throw new Error('录音请单独发送');
      if (pcm && !config.voice.enabled) throw new Error('电脑端还未开通语音');
      const { id, done } = handlers.chat.submit({ requestKey: 'web:' + input.id, text, image, pcm, wantAudio: Boolean(pcm), source: 'web' });
      done?.catch(() => {});
      return json(res, 202, { id });
    }

    return json(res, 404, { error: '页面不存在' });
  };

  const request = (req, res) => handle(req, res).catch(error => {
    if (!res.headersSent) json(res, 400, { error: error instanceof SyntaxError ? '消息格式无效' : error.message });
  });
  const server = tls
    ? https.createServer({ cert: await readFile(path.resolve(root, web.cert)), key: await readFile(path.resolve(root, web.key)) }, request)
    : http.createServer(request);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(web.port, web.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    url: `${httpProtocol}://${allowedHost()}`,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}
