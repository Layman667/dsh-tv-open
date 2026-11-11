import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const defaultProject = process.platform === 'win32' ? 'D:\\dsh-tv' : path.join(os.homedir(), 'dsh-tv');
export const dataDir = path.join(root, 'data');
export const configPath = path.join(dataDir, 'local.json');

const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const sample = () => readJson(path.join(root, 'config.example.json'));

export function isLocalAddress(host) {
  if (host === '127.0.0.1') return true;
  if (net.isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export async function init() {
  await mkdir(path.join(dataDir, 'reply-images'), { recursive: true });
  const config = await sample();
  config.web.password = randomBytes(12).toString('base64url');
  config.device.token = randomBytes(24).toString('base64url');
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  try {
    await writeFile(path.join(dataDir, 'persona.txt'), '你叫大肥鱼。用自然中文和朋友聊天。你友善、俏皮，通常用一到三句话作答；认真问题就认真回答。\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export async function loadConfig() {
  const defaults = await sample();
  const saved = await readJson(configPath);
  const config = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { ...value, ...saved[key] }]));
  const { web, device, pet, qq, voice } = config;
  for (const [label, part] of Object.entries({ web, device, pet })) {
    if (!Number.isInteger(part.port) || part.port < 1 || part.port > 65535) throw new Error(`${label}.port 无效`);
  }
  if (!isLocalAddress(web.host) || !isLocalAddress(device.host)) throw new Error('网页和设备请使用本机或家庭局域网 IPv4');
  if (web.host !== '127.0.0.1' && (!web.cert || !web.key)) throw new Error('开放局域网网页前，请配置 web.cert 和 web.key');
  if (Boolean(web.cert) !== Boolean(web.key)) throw new Error('HTTPS 需要同时配置证书和私钥');
  if (typeof web.password !== 'string' || web.password.length < 12) throw new Error('web.password 至少需要 12 字符');
  if (device.enabled && (typeof device.token !== 'string' || device.token.length < 16)) throw new Error('device.token 至少需要 16 字符');
  if (qq.enabled) {
    const url = new URL(qq.url);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('qq.url 应指向本机 NapCat 正向 WebSocket');
    if (!/^\d+$/.test(qq.owner) || !/^\d+$/.test(qq.bot) || String(qq.owner) === String(qq.bot) || !qq.token) throw new Error('请填写两个不同的 QQ 号及 NapCat 令牌');
  }
  if (voice.enabled && (!voice.asrApiKey || !voice.ttsApiKey || !voice.speaker)) throw new Error('请配置豆包 ASR、TTS 密钥和音色');
  config.dataDir = dataDir;
  return config;
}

export function deviceConfig(config) {
  return {
    listenHost: config.device.host,
    port: config.device.port,
    wsPath: '/',
    pairToken: config.device.token,
    display: { maxTextBytes: 330, replayLatestOnConnect: true, maxReplayAgeMinutes: 30 },
    voice: {
      enabled: config.voice.enabled,
      asrResourceId: 'volc.seedasr.sauc.duration',
      speaker: config.voice.speaker,
      speechRate: 0,
      maxRecordSeconds: 15,
      maxPlaybackSeconds: 90,
      maxSpeakChars: 300,
      cloudTimeoutMs: 60000
    }
  };
}

export function voiceKeys(config) {
  return { asr: config.voice.asrApiKey, tts: config.voice.ttsApiKey };
}
