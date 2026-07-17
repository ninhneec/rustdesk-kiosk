const query = new URLSearchParams(window.location.search);
const deviceId = query.get('device_id');
const deviceToken = query.get('token');
const channelSelect = document.getElementById('channel');
const messages = document.getElementById('messages');
const composer = document.getElementById('composer');
const input = document.getElementById('message');
const status = document.getElementById('status');
const cursors = { boss: 0, global: 0 };

if (!deviceId || !deviceToken) {
  status.textContent = 'Thiếu thông tin xác thực của máy. Hãy mở bảng chat từ RustDesk.';
  composer.hidden = true;
}

const requestHeaders = () => ({ 'Content-Type': 'application/json', 'X-Device-Id': deviceId, 'X-Device-Token': deviceToken });

function appendMessage(message) {
  const outgoing = message.sender_id === deviceId;
  const item = document.createElement('article');
  item.className = `message ${outgoing ? 'outgoing' : ''}`;
  const sender = document.createElement('strong');
  sender.textContent = outgoing ? 'Bạn' : message.sender_id === 'boss' ? 'Boss' : message.sender_id;
  const body = document.createElement('p');
  body.textContent = message.body;
  const time = document.createElement('time');
  time.textContent = new Date(`${message.created_at}Z`).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  item.append(sender, body, time);
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

async function loadMessages(reset = false) {
  const channel = channelSelect.value;
  if (reset) {
    messages.replaceChildren();
    cursors[channel] = 0;
  }
  try {
    const response = await fetch(`/api/chat/messages?channel=${encodeURIComponent(channel)}&after_id=${cursors[channel]}`, { headers: requestHeaders() });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    data.forEach((message) => {
      cursors[channel] = Math.max(cursors[channel], message.id);
      appendMessage(message);
    });
    status.textContent = channel === 'boss' ? 'Kênh riêng với boss' : 'Kênh chung';
  } catch (error) {
    console.error(error);
    status.textContent = 'Mất kết nối chat. Đang thử lại…';
  }
}

channelSelect.addEventListener('change', () => loadMessages(true));
composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = input.value.trim();
  if (!body) return;
  const response = await fetch('/api/chat/messages', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ channel: channelSelect.value, body }) });
  if (!response.ok) {
    status.textContent = 'Không gửi được tin nhắn.';
    return;
  }
  input.value = '';
  loadMessages();
});

loadMessages(true);
setInterval(() => loadMessages(), 2500);
