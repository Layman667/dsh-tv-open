import { readFile, writeFile, mkdir, symlink, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { root } from './config.mjs';

const packageDir = path.join(root, 'desktop', 'node_modules', 'dsh-pet');
const entry = path.join(packageDir, 'lib', 'standalone.js');
const id = 'main';

function insert(source, anchor, next) {
  if (source.split(anchor).length !== 2) throw new Error('桌宠文件版本与动作同步补丁不匹配。请重新安装桌宠依赖。');
  return source.replace(anchor, next);
}

async function patchDesktop() {
  const info = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  if (info.version !== '0.4.7') throw new Error('桌宠依赖需要版本 0.4.7');
  const sprite = path.join(packageDir, 'runtime', 'electron-helper', 'sprite.js');
  const files = await Promise.all([sprite, entry].map(file => readFile(file, 'utf8')));
  let [renderer, host] = files;
  if (!renderer.includes('dsh-tv visual reporter')) {
    renderer = insert(renderer, '    this.bindEvents();', `    this.bindEvents();
    // dsh-tv visual reporter
    this.tvTimer = window.setInterval(() => this.reportPose(), 220);`);
    renderer = insert(renderer, '    this.ac.abort();', '    window.clearInterval(this.tvTimer);\n    this.ac.abort();');
    renderer = insert(renderer, '      facing: this._facing,\n    };', `      facing: this._facing,
    };
    const video = this.front === 0 ? this.videoA : this.videoB;
    if (video?.readyState >= 2 && video.src.startsWith(this.assetBase)) {
      body.tvVisual = {
        name: decodeURIComponent(video.src.split('/').pop()).replace(/\\.webm$/i, ''),
        timeMs: Math.round(video.currentTime * 1000),
        paused: video.paused, loop: video.loop,
        flip: this._facing === 'right'
      };
    }`);
  }
  if (!host.includes('dsh-tv visual snapshot')) {
    host = insert(host, 'pose.set(who.petId, p.pose);', 'pose.set(who.petId, { ...p.pose, tvVisual: parsedPose.tvVisual });');
    host = insert(host, 'facing: pose.facing,\n\t\t\tupdatedAt:', 'facing: pose.facing,\n\t\t\ttvVisual: pose.tvVisual, // dsh-tv visual snapshot\n\t\t\tupdatedAt:');
  }
  for (const [index, file] of [sprite, entry].entries()) {
    const source = [renderer, host][index];
    if (source === files[index]) continue;
    await writeFile(file + '.tv-tmp', source);
    await rename(file + '.tv-tmp', file);
  }
}

export async function preparePet(home) {
  const dir = path.join(home, 'dsh-pet');
  const animations = path.join(dir, 'main-animation');
  await mkdir(animations, { recursive: true });
  try {
    await symlink(path.join(root, 'assets', 'desktop', 'webm'), path.join(animations, 'webm'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const options = {
    pets: [{ id, name: '大肥鱼', display: 'desktop', balanceEnabled: false, whisperEnabled: false, workStatusEnabled: true }]
  };
  try {
    await writeFile(path.join(dir, 'main-config.jsonc'), JSON.stringify(options, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await patchDesktop();
  return path.join(dir, 'standalone-runtime.json');
}

export class Pet {
  constructor(config, log = console.log) {
    this.config = config;
    this.log = log;
    this.home = path.join(config.dataDir, 'desktop-home');
    this.pending = Promise.resolve();
  }

  async start() {
    if (!this.config.pet.enabled) return;
    this.runtimeFile = await preparePet(this.home);
    const child = spawn(process.execPath, [entry, '--port', String(this.config.pet.port)], {
      env: { ...process.env, DSH_HOME: this.home },
      stdio: 'ignore',
      windowsHide: true
    });
    this.child = child;
    child.on('error', () => this.log('[桌宠] 启动失败。运行 npm run doctor 检查。'));
    child.once('exit', code => {
      if (!this.stopping) this.log(`[桌宠] 已退出（${code ?? '信号'}）。运行 npm run doctor 检查。`);
    });
    child.unref();
  }

  async runtime() {
    if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return null;
    try {
      const value = JSON.parse(await readFile(this.runtimeFile, 'utf8'));
      if (value.pid === this.child.pid && Number.isInteger(value.port) && typeof value.token === 'string') return value;
    } catch {
      // The helper writes this file when it starts listening.
    }
    return null;
  }

  async request(route, method = 'GET', body, base = '/dsh-pet-7340') {
    const runtime = await this.runtime();
    if (!runtime) return null;
    const response = await fetch(`http://127.0.0.1:${runtime.port}${base}${route}`, {
      method,
      headers: { 'X-DSH-Pet-Token': runtime.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1200)
    });
    if (!response.ok || response.status === 204) return null;
    return response.json();
  }

  async visual() {
    try {
      const pose = await this.request('/pose?pet=' + id);
      const value = pose?.tvVisual;
      if (!pose?.ok || Date.now() - pose.updatedAt > 2500 || !Number.isInteger(value?.timeMs) || value.timeMs < 0) return null;
      return { ...value, mode: 'motion', receivedAt: pose.updatedAt };
    } catch {
      return null;
    }
  }

  state(state, text) {
    if (!this.config.pet.enabled) return;
    this.pending = this.pending.then(async () => {
      if (state === 'speaking') {
        await this.request('/work-status', 'DELETE');
        const lock = await this.request('/lock?pet=' + id, 'POST', { ttl: 3000 });
        if (!lock?.ok) return;
        try {
          await this.request('/broadcast?pet=' + id + '&lock=' + encodeURIComponent(lock.lockId), 'POST',
            { text: [...text].slice(0, 260).join(''), duration: 8500, anim: true });
        } finally {
          await this.request('/lock/release?pet=' + id, 'POST', { lockId: lock.lockId });
        }
      } else if (state === 'idle') {
        await this.request('/work-status', 'DELETE');
      } else {
        await this.request('/work-status', 'POST', { state: state === 'listening' ? 'waiting' : 'thinking' });
      }
    }).catch(() => {});
  }

  async stop() {
    this.stopping = true;
    if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, 'exit').catch(() => {});
    await this.request('/shutdown', 'POST', undefined, '').catch(() => {});
    await Promise.race([exited, delay(1600)]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}
