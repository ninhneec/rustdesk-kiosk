const adminToken = sessionStorage.getItem('rustdesk-admin-token') || window.prompt('Nhập ADMIN_TOKEN');
if (adminToken) sessionStorage.setItem('rustdesk-admin-token', adminToken);

const headers = () => ({ Authorization: `Bearer ${adminToken}` });
const deviceList = document.getElementById('device-list');
const deviceCount = document.getElementById('device-count');
const searchInput = document.getElementById('search-input');
const refreshBtn = document.getElementById('refresh-btn');
const toast = document.getElementById('toast');
let devices = [];

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
refreshBtn.addEventListener('click', fetchDevices);
fetchDevices();
setInterval(fetchDevices, 30000);

window.copyToClipboard = async (value) => {
  await navigator.clipboard.writeText(value);
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
};
