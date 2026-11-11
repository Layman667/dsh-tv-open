import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_IMAGE, picture, wav } from './media.mjs';

const availableImage = /^[\p{L}\p{N}_. -]{1,80}\.(png|jpe?g|webp|gif)$/iu;
const safeErrors = {
  asr: '语音识别失败。请核对豆包 ASR 密钥、资源开通和录音。',
  dsh: 'DSH 回复失败。请运行诊断并检查 DeepSeek 模型、密钥和余额。'
};

export class Chat {
  constructor({ store, model, dataDir, voice, onMessage = () => {}, onState = () => {}, log = console.log }) {
    Object.assign(this, { store, model, dataDir, voice, onMessage, onState, log });
    this.tail = Promise.resolve();
    this.closed = false;
  }

  submit(turn) {
    if (this.closed) throw new Error('服务正在停止');
    const { row, fresh } = this.store.reserve({ ...turn, audio: turn.pcm ? wav(turn.pcm) : null });
    if (!fresh) return { id: row.id, fresh };
    const done = this.tail.then(() => this.process(row, turn));
    this.tail = done.catch(() => {});
    return { id: row.id, fresh, done };
  }

  async replyImages() {
    const files = await readdir(path.join(this.dataDir, 'reply-images'), { withFileTypes: true });
    return files.filter(file => file.isFile() && availableImage.test(file.name)).map(file => file.name).slice(0, 30);
  }

  async readReplyImage(name) {
    const file = path.join(this.dataDir, 'reply-images', name);
    try {
      if ((await stat(file)).size <= MAX_IMAGE) return picture(await readFile(file));
    } catch {
      // A file may be removed while a reply is being generated.
    }
    return null;
  }

  async process(row, { source, text, image, pcm, wantAudio, deliver }) {
    let phase = 'asr';
    try {
      if (pcm && !text) {
        this.onState('listening');
        text = await this.voice.recognize(pcm);
        this.store.setText(row.id, text);
      }
      phase = 'dsh';
      this.onMessage({ source, role: 'user', text });
      this.onState('thinking');
      const files = await this.replyImages();
      const answer = await this.model.ask(text, image, files);
      const match = answer.match(/(?:^|\n)\[图片:([^\]\r\n]+)\]\s*$/u);
      const chosen = match && files.includes(match[1]) ? await this.readReplyImage(match[1]) : null;
      const response = (match ? answer.slice(0, match.index) : answer).trim() || (chosen ? '给你看这张图。' : '这次没有生成回复。');
      const result = this.store.finish(row.id, { source, text: response, image: chosen });
      this.onMessage(result);
      this.onState('speaking', response);
      let audio;
      let audioError;
      if (wantAudio) {
        try {
          audio = await this.voice.synthesize(response);
          this.store.setAudio(result.id, wav(audio));
        } catch {
          audio = undefined;
          audioError = '语音合成失败，文字回复已保存。请核对豆包 TTS 2.0 密钥和音色。';
          this.store.note(result.id, audioError);
          this.log('[语音] TTS 未完成');
        }
      }
      await deliver?.(response).catch(() => this.log('[QQ] 本轮回复已保存，发送失败。请查看网页记录和 NapCat 状态。'));
      return { text: response, audio, audioError, published: true };
    } catch {
      const error = safeErrors[phase];
      this.store.fail(row.id, error);
      this.log(`[聊天] ${error}`);
      await deliver?.(error).catch(() => {});
      throw new Error(error);
    } finally {
      this.onState('idle');
    }
  }

  async stop() {
    this.closed = true;
    await this.tail;
    await this.model.close();
  }
}
