import { readFile, writeFile, access } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { init, loadConfig, root, configPath, defaultProject, isLocalAddress } from './config.mjs';
import { DshModel } from './model.mjs';

const variants = {
  'direct-v1': { firmware: 'esp32-v1', mirror: 'none' },
  'direct-v2': { firmware: 'esp32-v2', mirror: 'none' },
  'prism-v1': { firmware: 'esp32-v1', mirror: 'x' },
  'prism-v2': { firmware: 'esp32-v2', mirror: 'x' }
};

function cString(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Wi-Fi 信息含无效字符');
  return JSON.stringify(value);
}

async function firmware(variant, file) {
  const kind = variants[variant];
  if (!kind || !file) throw new Error('用法：npm run firmware -- direct-v1|direct-v2|prism-v1|prism-v2 data/wifi.local.json');
  const config = await loadConfig();
  if (!config.device.enabled || config.device.host === '127.0.0.1') throw new Error('请启用设备桥接并填写本机局域网 IPv4');
  const { ssid, password, rotation = 0, mirror = kind.mirror, inverted = false } =
    JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (!ssid || Buffer.byteLength(ssid) > 32) throw new Error('请填写 2.4 GHz Wi-Fi 名称，最多 32 字节');
  if (![0, 1, 2, 3].includes(rotation) || !['none', 'x', 'y'].includes(mirror) || typeof inverted !== 'boolean')
    throw new Error('rotation 只能为 0 至 3，mirror 为 none / x / y，inverted 为布尔值');
  const base = path.join(root, kind.firmware, 'include');
  let header = await readFile(path.join(base, 'user_config.h.example'), 'utf8');
  for (const [name, value] of Object.entries({
    WIFI_SSID: ssid, WIFI_PASSWORD: password, PC_HOST: config.device.host, PAIR_TOKEN: config.device.token
  })) {
    header = header.replace(new RegExp(`(${name}\\[\\] = )"[^"]*";`), (_, prefix) => prefix + cString(value) + ';');
  }
  header = header.replace(/(PC_PORT = )\d+;/, (_, prefix) => prefix + config.device.port + ';');
  header = header.replace(/^#define DSH_DEMO_MODE 1$/m, '#define DSH_DEMO_MODE 0');
  header = header.replace(/^#define DSH_TFT_INVERTED false$/m, '#define DSH_TFT_INVERTED ' + inverted);
  header = header.replace(/^#define DSH_TFT_ROTATION \d$/m, '#define DSH_TFT_ROTATION ' + rotation);
  header = header.replace(/^#define DSH_SCREEN_MIRROR \d$/m, '#define DSH_SCREEN_MIRROR ' + ['none', 'x', 'y'].indexOf(mirror));
  await writeFile(path.join(base, 'user_config.h'), header, { mode: 0o600 });
  console.log(`已生成 ${kind.firmware}/include/user_config.h。屏幕旋转 ${rotation}，镜像 ${mirror}。`);
  console.log(`在 ${kind.firmware} 目录运行 pio run -e esp32-s3-devkitc-1 -t upload。N8R8 改用 esp32-s3-n8r8。`);
}

async function doctor(probeModel) {
  console.log(`Node ${process.versions.node} | ${process.platform} ${process.arch}`);
  console.log(`项目 ${root} | 默认目录 ${defaultProject}`);
  const config = await loadConfig();
  console.log(`DeepSeek ${config.deepseek.model} | 密钥${config.deepseek.apiKey ? '已配置' : '待配置'}`);
  const local = Object.values(networkInterfaces()).flat().filter(info => info && !info.internal && isLocalAddress(info.address));
  console.log('局域网 IPv4', local.map(info => info.address).join('、') || '未发现');
  console.log(`网页 ${config.web.host}:${config.web.port} | ${config.web.cert ? 'HTTPS' : '本机 HTTP'}`);
  for (const label of ['web', 'device']) {
    const host = config[label].host;
    if (host !== '127.0.0.1' && !local.some(info => info.address === host))
      console.log(`[待处理] ${label}.host 不在当前网卡上，请检查电脑 IP 是否变化`);
  }
  for (const file of [config.web.cert, config.web.key].filter(Boolean)) await access(path.resolve(root, file));
  console.log(`NapCat ${config.qq.enabled ? '已配置，启动后核对真实登录' : '未启用'} | 豆包语音 ${config.voice.enabled ? '已配置' : '未启用'} | ESP32 ${config.device.enabled ? '已启用' : '未启用'}`);
  if (config.pet.enabled) {
    const file = path.join(config.dataDir, 'desktop-home', 'dsh-pet', 'standalone-runtime.json');
    try {
      const runtime = JSON.parse(await readFile(file, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${runtime.port}/dsh-pet-7340/pose?pet=main`, {
        headers: { 'X-DSH-Pet-Token': runtime.token }, signal: AbortSignal.timeout(1500)
      });
      const pose = response.ok && await response.json();
      console.log(pose?.ok && Date.now() - pose.updatedAt < 3000 ? '桌宠窗口正在上报实况' : '桌宠窗口暂无实况，请在朋友电脑桌面检查');
    } catch {
      console.log('桌宠未运行或正在启动');
    }
  }
  if (probeModel) {
    const model = new DshModel(config, { getSetting: () => undefined, setSetting: () => {} });
    try {
      await model.start();
      console.log('DSH SDK 握手成功');
      if (probeModel === '--live') {
        const result = await model.ask('请只回复：连接成功', null, []);
        console.log(`DeepSeek 测试回复：${result}`);
      }
    } finally {
      await model.close();
    }
  }
}

const [, , action, ...args] = process.argv;
try {
  if (action === 'init') {
    await init();
    console.log(`填写本机配置 ${configPath}`);
  } else if (action === 'doctor') {
    await doctor(args[0]);
  } else if (action === 'firmware') {
    await firmware(...args);
  } else {
    throw new Error('请使用 init、doctor 或 firmware');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
