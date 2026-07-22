'use strict';

const params = new URLSearchParams(window.location.search);
const deviceId = params.get('device_id');
const deviceName = params.get('hostname') || deviceId;
const channelSelect = document.getElementById('channel');
const messages = document.getElementById('messages');
const composer = document.getElementById('composer');
const input = document.getElementById('message');
const status = document.getElementById('status');
const emptyChat = document.getElementById('empty-chat');
const cursors = { boss: 0, global: 0 };
let loading = false;

document.getElementById('title').textContent = deviceName || 'Thiếu thiết bị';
document.getElementById('close-chat').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.close(); });

function serverDate(value) {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
}

function appendMessage(message) {
  emptyChat.hidden = true;
  const item = document.createElement('article');
  item.className = `message ${message.sender_id === 'boss' ? 'outgoing' : ''}`;
  const sender = document.createElement('strong');
  sender.textContent = message.sender_id === 'boss' ? 'Bạn' : (deviceName || message.sender_id);
  const body = document.createElement('p');
  body.textContent = message.body;
  const time = document.createElement('time');
  time.textContent = serverDate(message.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  item.append(sender, body, time);
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

async function loadMessages(reset = false) {
  const channel = channelSelect.value;
  if ((!deviceId && channel === 'boss') || loading) return;
  loading = true;
  if (reset) {
    messages.replaceChildren(emptyChat);
    emptyChat.hidden = false;
    cursors[channel] = 0;
  }
  const url = new URL('/api/admin/chat/messages', window.location.origin);
  url.searchParams.set('channel', channel);
  url.searchParams.set('after_id', cursors[channel]);
  if (channel === 'boss') url.searchParams.set('device_id', deviceId);
  try {
    const response = await fetch(url);
    if (response.status === 401) {
      status.textContent = 'Phiên quản trị đã hết hạn';
      input.disabled = true;
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    data.forEach((message) => {
      cursors[channel] = Math.max(cursors[channel], message.id);
      appendMessage(message);
    });
    status.textContent = channel === 'boss' ? `Riêng tư · ${deviceId}` : 'Kênh chung · Realtime';
  } catch (error) {
    console.error(error);
    status.textContent = 'Mất kết nối · đang thử lại';
  } finally {
    loading = false;
  }
}

channelSelect.addEventListener('change', () => loadMessages(true));
composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = input.value.trim();
  if (!body) return;
  const button = composer.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channelSelect.value, device_id: deviceId, body }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    input.value = '';
    await loadMessages();
  } catch (_error) {
    status.textContent = 'Không gửi được tin nhắn';
  } finally {
    button.disabled = false;
    input.focus();
  }
});

const events = new EventSource('/api/admin/events');
events.addEventListener('chat-alert', (event) => {
  const alert = JSON.parse(event.data);
  if (channelSelect.value === 'global' || alert.device_id === deviceId) loadMessages();
});
events.onerror = () => { status.textContent = 'Đang nối lại realtime…'; };

loadMessages(true);
setInterval(() => { if (!document.hidden) loadMessages(); }, 3000);
