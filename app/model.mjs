import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './config.mjs';

export class DshModel {
  constructor(config, store) {
    Object.assign(this, { config, store });
  }

  async start() {
    if (this.harness) return;
    if (!this.config.deepseek.apiKey) throw new Error('请先填写 deepseek.apiKey');
    const cwd = path.join(this.config.dataDir, 'workspace');
    await mkdir(cwd, { recursive: true });
    const persona = await readFile(path.join(this.config.dataDir, 'persona.txt'), 'utf8');
    const harness = new DeepSeekHarness({
      dshBin: path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      profile: 'sdk-minimal',
      patches: [path.join(root, 'app', 'chat-profile.yml')],
      dshHome: path.join(this.config.dataDir, 'dsh-home'),
      cwd,
      processCwd: cwd,
      provider: 'deepseek-official',
      model: this.config.deepseek.model,
      env: { ...process.env, DEEPSEEK_API_KEY: this.config.deepseek.apiKey, DSH_SYSTEM_PROMPT: persona.trim() },
      initializeTimeoutMs: 30000,
      requestTimeoutMs: 120000
    });
    try {
      await harness.start();
      const id = this.store.getSetting('dsh-session');
      this.session = id ? await harness.resumeSession(id) : harness.session();
      this.harness = harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  async ask(text, image, files) {
    await this.start();
    const list = files.length ? `\n\n可随回复附上一张已有的图片。只有合适时，在末尾单独写 [图片:文件名]。可选文件名：${files.join('、')}。` : '';
    const input = [{ type: 'text', text: (text || '请看看这张图片。') + list }];
    if (image) input.push({ type: 'image', data: image.bytes.toString('base64'), mimeType: image.mime });
    let result;
    try {
      result = await this.session.run(input);
      this.store.setSetting('dsh-session', this.session.id);
    } catch (error) {
      // Reopen the same persisted session on the next turn if the runtime exited.
      await this.close();
      throw error;
    }
    if (result.finishReason !== 'completed' || !result.finalResponse?.trim()) throw new Error('模型没有完成回复');
    return result.finalResponse.trim();
  }

  async close() {
    const harness = this.harness;
    this.harness = null;
    this.session = null;
    await harness?.close();
  }
}
