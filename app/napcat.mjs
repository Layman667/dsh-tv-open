import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

export class NapCat {
  constructor(config, chat, log = console.log) {
    Object.assign(this, { config, chat, log });
    this.calls = new Map();
    this.ready = false;
    this.closed = false;
  }

  start() {
    if (this.closed || !this.config.enabled) return;
    const socket = new WebSocket(this.config.url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      handshakeTimeout: 5000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false
    });
    this.socket = socket;
    socket.on('error', () => {});
    socket.on('open', async () => {
      try {
        const data = await this.call('get_login_info', {});
        if (socket !== this.socket || socket.readyState !== WebSocket.OPEN || this.closed) return;
        if (String(data?.user_id) !== String(this.config.bot)) throw new Error('NapCat 登录账号与配置的机器人 QQ 不符');
        this.ready = true;
        this.log('[QQ] NapCat 已登录，等待主人私聊');
      } catch {
        this.log('[QQ] NapCat 未就绪，请检查扫码登录、机器人 QQ 和 OneBot 令牌');
        socket.close();
      }
    });
    socket.on('message', (bytes, binary) => {
      if (binary) return;
      try {
        this.receive(JSON.parse(bytes.toString()));
      } catch {
        this.log('[QQ] 忽略无法处理的消息');
      }
    });
    socket.on('close', () => {
      this.ready = false;
      for (const call of this.calls.values()) call.reject(new Error('NapCat 连接关闭'));
      this.calls.clear();
      if (!this.closed) this.retry = setTimeout(() => this.start(), 4000);
    });
  }

  call(action, params) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NapCat 未连接'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        this.calls.delete(echo);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('NapCat 请求超时')), 8000);
      this.calls.set(echo, { resolve: value => finish(null, value), reject: finish });
      socket.send(JSON.stringify({ action, params, echo }), error => { if (error) finish(error); });
    });
  }

  receive(event) {
    const call = this.calls.get(event.echo);
    if (call) {
      if (event.status === 'ok' && event.retcode === 0) call.resolve(event.data);
      else call.reject(new Error('NapCat 拒绝请求'));
      return;
    }
    const { owner, bot } = this.config;
    if (!this.ready || event.post_type !== 'message' || event.message_type !== 'private'
      || String(event.self_id) !== String(bot) || String(event.user_id) !== String(owner)
      || !Number.isSafeInteger(event.message_id) || !Array.isArray(event.message)) return;
    const text = event.message.filter(part => part?.type === 'text' && typeof part.data?.text === 'string')
      .map(part => part.data.text).join('').trim().slice(0, 12000);
    if (!text) return;
    const { done } = this.chat.submit({
      requestKey: `qq:${bot}:${event.message_id}`,
      source: 'qq',
      text,
      deliver: reply => {
        if (!this.ready) return Promise.reject(new Error('NapCat 未就绪'));
        return this.call('send_private_msg', {
          user_id: Number(owner), message: [{ type: 'text', data: { text: reply } }]
        });
      }
    });
    done?.catch(() => {});
  }

  stop() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.retry);
    this.socket?.terminate();
  }
}
