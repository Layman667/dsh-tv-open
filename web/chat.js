const $ = id => document.getElementById(id);
const timeline = $('timeline');
const messages = $('messages');
const composer = $('composer');
const cached = new Map();
let image, pcm, recording, starting = false, sending = false, unlocked = false, polling = false;
let requestId = null;

async function api(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || '服务暂不可用'), { status: response.status });
  return value;
}

function signedOut() {
  unlocked = false;
  $('connection').textContent = '等待登录';
  $('login').hidden = false;
  $('chat').hidden = true;
}

const channel = { qq: 'QQ', web: '网页', v2: '设备语音' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(message, item) {
  const signature = JSON.stringify(message);
  if (item?.signature === signature) return item.node;
  const node = item?.node || element('article');
  const oldAudio = node.querySelector('audio');
  node.className = 'message ' + message.role;
  node.replaceChildren();
  const time = new Date(message.created).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  node.append(element('div', `${message.role === 'user' ? '你' : '大肥鱼'} · ${channel[message.source]} · ${time}`, 'meta'));
  const bubble = element('div', '', 'bubble');
  if (message.text) bubble.append(element('p', message.text));
  if (message.image) {
    const img = element('img');
    img.alt = '聊天图片';
    img.loading = 'lazy';
    img.src = '/api/media/' + message.image;
    bubble.append(img);
  }
  if (message.audio) {
    const audio = oldAudio || element('audio');
    audio.controls = true;
    audio.preload = 'none';
    if (!oldAudio) audio.src = '/api/media/' + message.audio;
    bubble.append(audio);
  }
  if (message.state === 'pending') bubble.append(element('small', '正在处理…'));
  if (message.error) bubble.append(element('small', message.error));
  node.append(bubble);
  cached.set(message.id, { signature, node });
  return node;
}

async function refresh(before) {
  if (polling) return;
  polling = true;
  try {
    const isNearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
    const previousHeight = timeline.scrollHeight;
    const result = await api('/api/history' + (before ? '?before=' + before : ''));
    const firstLoad = !unlocked;
    unlocked = true;
    $('login').hidden = true;
    $('chat').hidden = false;
    $('connection').textContent = '本地聊天';
    $('record').hidden = !result.voice;
    if (result.messages.length) $('empty').hidden = true;
    const newlyLoaded = document.createDocumentFragment();
    for (const message of result.messages) {
      const item = cached.get(message.id);
      const node = render(message, item);
      if (!item) newlyLoaded.append(node);
    }
    if (before) {
      messages.prepend(newlyLoaded);
      timeline.scrollTop += timeline.scrollHeight - previousHeight;
    } else {
      messages.append(newlyLoaded);
      if (firstLoad || isNearBottom) timeline.scrollTop = timeline.scrollHeight;
    }
    if (before || firstLoad) $('older').hidden = result.messages.length < 60;
  } catch (error) {
    if (error.status === 401) signedOut();
    else $('connection').textContent = '暂时连不上电脑';
  } finally {
    polling = false;
  }
}

$('login').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/login', { password: $('password').value });
    $('password').value = '';
    $('login-note').textContent = '';
    await refresh();
  } catch (error) {
    $('login-note').textContent = error.message;
  }
});

$('older').addEventListener('click', () => {
  if (cached.size) refresh(Math.min(...cached.keys()));
});

function resetDraft() {
  image = undefined;
  pcm = undefined;
  $('image').value = '';
  $('draft').hidden = true;
  requestId = null;
}

$('remove').addEventListener('click', resetDraft);
$('text').addEventListener('input', () => { requestId = null; });

$('image').addEventListener('change', async () => {
  const file = $('image').files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    $('notice').textContent = '请选择小于 8 MB 的图片';
    $('image').value = '';
    return;
  }
  resetDraft();
  const reader = new FileReader();
  reader.onload = () => {
    image = reader.result.split(',')[1];
    $('draft-label').textContent = file.name;
    $('draft').hidden = false;
    $('notice').textContent = '';
  };
  reader.onerror = () => { $('notice').textContent = '读取图片失败，请重新选择'; };
  reader.readAsDataURL(file);
});

function encodeRecording(chunks, sourceRate) {
  const input = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  const count = Math.min(240000, Math.floor(input.length * 16000 / sourceRate));
  if (count < 4000) throw new Error('录音太短，请重录');
  const buffer = new Uint8Array(count * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * sourceRate / 16000);
    const to = Math.max(from + 1, Math.floor((i + 1) * sourceRate / 16000));
    let sum = 0;
    for (let n = from; n < to; n++) sum += input[n];
    const sample = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(i * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  const pieces = [];
  for (let i = 0; i < buffer.length; i += 8192) pieces.push(String.fromCharCode(...buffer.subarray(i, i + 8192)));
  return btoa(pieces.join(''));
}

async function stopRecording() {
  const active = recording;
  if (!active) return;
  recording = null;
  clearTimeout(active.timer);
  active.stream.getTracks().forEach(track => track.stop());
  await active.context.close().catch(() => {});
  $('record').textContent = '录音';
  $('record').setAttribute('aria-pressed', 'false');
  $('send').disabled = false;
  try {
    pcm = encodeRecording(active.chunks, active.sampleRate);
    $('draft-label').textContent = '录音已就绪';
    $('draft').hidden = false;
    $('notice').textContent = '';
  } catch (error) {
    $('notice').textContent = error.message;
  }
}

$('record').addEventListener('click', async () => {
  if (recording) return stopRecording();
  if (starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('notice').textContent = '手机录音需要先信任本地 HTTPS 证书';
    return;
  }
  starting = true;
  let stream, context;
  try {
    resetDraft();
    context = new AudioContext();
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    await context.audioWorklet.addModule('/record.js');
    const processor = new AudioWorkletNode(context, 'microphone-capture');
    const gain = context.createGain();
    gain.gain.value = 0;
    context.createMediaStreamSource(stream).connect(processor).connect(gain).connect(context.destination);
    const chunks = [];
    processor.port.onmessage = event => chunks.push(event.data);
    recording = { context, stream, chunks, sampleRate: context.sampleRate, timer: setTimeout(stopRecording, 15000) };
    $('record').textContent = '结束录音';
    $('record').setAttribute('aria-pressed', 'true');
    $('send').disabled = true;
    $('notice').textContent = '录音中，最多 15 秒';
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    await context?.close().catch(() => {});
    $('notice').textContent = '无法录音，请检查浏览器麦克风权限';
  } finally {
    starting = false;
  }
});

composer.addEventListener('submit', async event => {
  event.preventDefault();
  if (recording || starting || sending) return;
  const text = $('text').value.trim();
  if (!text && !image && !pcm) return;
  sending = true;
  $('send').disabled = true;
  try {
    requestId ||= crypto.randomUUID();
    await api('/api/messages', { id: requestId, text: pcm ? '' : text, image, pcm });
    if (!pcm) $('text').value = '';
    resetDraft();
    $('notice').textContent = '';
    await refresh();
  } catch (error) {
    $('notice').textContent = error.message;
  } finally {
    $('send').disabled = false;
    sending = false;
  }
});

window.addEventListener('pagehide', () => recording?.stream.getTracks().forEach(track => track.stop()));
await refresh();
setInterval(() => {
  if (unlocked && document.visibilityState === 'visible') refresh();
}, 1600);
