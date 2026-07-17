const params = new URLSearchParams(window.location.search);
const deviceId = params.get('device_id');
const deviceName = params.get('hostname') || deviceId;
const adminToken = sessionStorage.getItem('rustdesk-admin-token') || window.prompt('Nhập ADMIN_TOKEN');
const channelSelect = document.getElementById('channel');
const messages = document.getElementById('messages');
const composer = document.getElementById('composer');
const input = document.getElementById('message');
const status = document.getElementById('status');
const cursors = { boss: 0, global: 0 };
document.getElementById('title').textContent = deviceName || 'Thiếu thiết bị';

const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` });
function appendMessage(message) {
  const item = document.createElement('article');
  item.className = `message ${message.sender_id === 'boss' ? 'outgoing' : ''}`;
  const sender = document.createElement('strong'); sender.textContent = message.sender_id === 'boss' ? 'Bạn' : message.sender_id;
  const body = document.createElement('p'); body.textContent = message.body;
  const time = document.createElement('time'); time.textContent = new Date(`${message.created_at}Z`).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  item.append(sender, body, time); messages.append(item); messages.scrollTop = messages.scrollHeight;
}
async function loadMessages(reset = false) {
  const channel = channelSelect.value;
  if (!deviceId && channel === 'boss') return;
  if (reset) { messages.replaceChildren(); cursors[channel] = 0; }
  const url = new URL('/api/admin/chat/messages', window.location.origin);
  url.searchParams.set('channel', channel); url.searchParams.set('after_id', cursors[channel]);
  if (channel === 'boss') url.searchParams.set('device_id', deviceId);
  try {
    const response = await fetch(url, { headers: headers() });
    if (!response.ok) throw new Error(await response.text());
    (await response.json()).forEach((message) => { cursors[channel] = Math.max(cursors[channel], message.id); appendMessage(message); });
    status.textContent = channel === 'boss' ? `Kênh riêng · ${deviceId}` : 'Kênh chung';
  } catch (error) { console.error(error); status.textContent = 'Mất kết nối chat.'; }
}
channelSelect.addEventListener('change', () => loadMessages(true));
composer.addEventListener('submit', async (event) => {
  event.preventDefault(); const body = input.value.trim(); if (!body) return;
  const response = await fetch('/api/admin/chat/messages', { method: 'POST', headers: headers(), body: JSON.stringify({ channel: channelSelect.value, device_id: deviceId, body }) });
  if (!response.ok) { status.textContent = 'Không gửi được tin nhắn.'; return; }
  input.value = ''; loadMessages();
});
loadMessages(true); setInterval(() => loadMessages(), 2500);
