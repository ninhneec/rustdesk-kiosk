const adminToken = sessionStorage.getItem('rustdesk-admin-token') || window.prompt('Nhập ADMIN_TOKEN');
if (adminToken) sessionStorage.setItem('rustdesk-admin-token', adminToken);

const headers = () => ({ Authorization: `Bearer ${adminToken}` });
const deviceList = document.getElementById('device-list');
const deviceCount = document.getElementById('device-count');
const searchInput = document.getElementById('search-input');
const refreshBtn = document.getElementById('refresh-btn');
const toast = document.getElementById('toast');
const alertPanel = document.getElementById('alert-panel');
const alertList = document.getElementById('alert-list');
const alertCount = document.getElementById('alert-count');
const keywordsInput = document.getElementById('keywords-input');
const saveKeywordsBtn = document.getElementById('save-keywords-btn');
const settingsMessage = document.getElementById('settings-message');

let devices = [];
let alerts = [];
let refreshTimer;

async function fetchDevices() {
  try {
    const response = await fetch('/api/admin/devices', { headers: headers() });
    if (!response.ok) throw new Error(await response.text());
    devices = await response.json();
    renderDevices(devices);
  } catch (error) {
    console.error('Could not load devices:', error);
    deviceList.innerHTML = '<tr><td colspan="6" class="error">Không thể tải thiết bị. Kiểm tra ADMIN_TOKEN.</td></tr>';
  }
}

async function fetchAlerts() {
  try {
    const response = await fetch('/api/admin/chat/alerts', { headers: headers() });
    if (!response.ok) throw new Error(await response.text());
    alerts = await response.json();
    renderAlerts();
  } catch (error) {
    console.error('Could not load chat alerts:', error);
  }
}

function renderAlerts() {
  alertList.replaceChildren();
  alertPanel.hidden = alerts.length === 0;
  alertCount.textContent = alerts.length ? `${alerts.length} chưa xử lý` : '';
  alerts.forEach((alert) => {
    const item = document.createElement('article');
    item.className = 'chat-alert';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${alert.hostname} · ID ${alert.device_id}`;
    const message = document.createElement('p');
    message.textContent = alert.body;
    const meta = document.createElement('small');
    meta.textContent = `Từ khóa: “${alert.matched_keyword}” · ${new Date(`${alert.created_at}Z`).toLocaleString('vi-VN')}`;
    details.append(title, message, meta);
    const actions = document.createElement('div');
    const chatButton = document.createElement('button');
    chatButton.className = 'btn-chat';
    chatButton.textContent = 'Mở chat';
    chatButton.addEventListener('click', () => openBossChat({ id: alert.device_id, hostname: alert.hostname }));
    const acknowledgeButton = document.createElement('button');
    acknowledgeButton.className = 'btn-acknowledge';
    acknowledgeButton.textContent = 'Đã xử lý';
    acknowledgeButton.addEventListener('click', () => acknowledgeAlert(alert.id));
    actions.append(chatButton, acknowledgeButton);
    item.append(details, actions);
    alertList.append(item);
  });
}

async function acknowledgeAlert(alertId) {
  const response = await fetch(`/api/admin/chat/alerts/${alertId}/acknowledge`, {
    method: 'POST',
    headers: headers(),
  });
  if (!response.ok) return;
  alerts = alerts.filter((alert) => alert.id !== alertId);
  renderAlerts();
}

function renderDevices(data) {
  deviceList.replaceChildren();
  const onlineCount = data.filter((device) => (Date.now() - new Date(`${device.last_seen}Z`)) < 5 * 60 * 1000).length;
  deviceCount.textContent = `${onlineCount} Online`;
  if (!data.length) {
    deviceList.innerHTML = '<tr><td colspan="6" class="empty">Chưa có thiết bị nào kết nối</td></tr>';
    return;
  }
  data.forEach((device) => {
    const lastSeen = new Date(`${device.last_seen}Z`);
    const online = (Date.now() - lastSeen) < 5 * 60 * 1000;
    const row = document.createElement('tr');
    row.innerHTML = `<td><span class="status-indicator ${online ? '' : 'offline'}"></span></td><td></td><td></td><td></td><td class="time-cell"></td><td><button class="btn-chat">Nhắn boss</button> <a class="btn-connect">Kết nối</a></td>`;
    const cells = row.querySelectorAll('td');
    cells[1].textContent = device.hostname || 'Unknown';
    cells[2].textContent = device.id;
    cells[3].textContent = device.pass;
    cells[4].textContent = lastSeen.toLocaleString('vi-VN');
    row.querySelector('.btn-connect').href = `rustdesk://connect?id=${encodeURIComponent(device.id)}`;
    row.querySelector('.btn-chat').addEventListener('click', () => openBossChat(device));
    deviceList.append(row);
  });
}

function openBossChat(device) {
  const url = new URL('/boss-chat.html', window.location.origin);
  url.searchParams.set('device_id', device.id);
  url.searchParams.set('hostname', device.hostname || device.id);
  window.open(url, '_blank', 'noopener');
}

searchInput.addEventListener('input', () => {
  const keyword = searchInput.value.toLowerCase();
  renderDevices(devices.filter((device) => `${device.hostname} ${device.id}`.toLowerCase().includes(keyword)));
});

async function fetchKeywords() {
  if (!adminToken) return;
  try {
    const response = await fetch('/api/admin/settings/keywords', { headers: headers() });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    keywordsInput.value = data.keywords;
  } catch (error) {
    console.error('Could not load keywords:', error);
    keywordsInput.placeholder = 'Lỗi tải từ khóa. Kiểm tra ADMIN_TOKEN.';
  }
}

saveKeywordsBtn.addEventListener('click', async () => {
  saveKeywordsBtn.disabled = true;
  settingsMessage.textContent = 'Đang lưu...';
  settingsMessage.style.color = 'var(--text-secondary)';
  try {
    const response = await fetch('/api/admin/settings/keywords', {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: keywordsInput.value })
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    keywordsInput.value = data.keywords;
    settingsMessage.textContent = 'Đã lưu thành công!';
    settingsMessage.style.color = 'var(--success-color)';
    setTimeout(() => { settingsMessage.textContent = ''; }, 3000);
  } catch (error) {
    console.error('Could not save keywords:', error);
    settingsMessage.textContent = 'Lỗi khi lưu!';
    settingsMessage.style.color = 'var(--danger-color)';
  } finally {
    saveKeywordsBtn.disabled = false;
  }
});

async function refreshDashboard() {
  clearTimeout(refreshTimer);
  if (!document.hidden) await Promise.all([fetchDevices(), fetchAlerts()]);
  refreshTimer = setTimeout(refreshDashboard, document.hidden ? 30000 : 5000);
}

refreshBtn.addEventListener('click', refreshDashboard);
document.addEventListener('visibilitychange', refreshDashboard);
fetchKeywords();
refreshDashboard();

window.copyToClipboard = async (value) => {
  await navigator.clipboard.writeText(value);
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
};
