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
  
  if (typeof updateMap === 'function') updateMap(data);
  
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

/* --- Tabs Logic --- */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-list').style.display = tab === 'list' ? 'block' : 'none';
  document.getElementById('tab-map').style.display = tab === 'map' ? 'block' : 'none';
  if(tab === 'list') document.querySelector('.tab-btn:nth-child(1)').classList.add('active');
  if(tab === 'map') {
      document.querySelector('.tab-btn:nth-child(2)').classList.add('active');
      if (!window.mapRendered) renderMapGrid();
  }
}

/* --- Map Zoom Logic --- */
let currentZoom = 1.0;
function zoomMap(delta) {
    currentZoom += delta;
    if (currentZoom < 0.5) currentZoom = 0.5;
    if (currentZoom > 1.5) currentZoom = 1.5;
    document.getElementById('map-grid-container').style.transform = `scale(${currentZoom})`;
}
function resetZoom() {
    currentZoom = 1.0;
    document.getElementById('map-grid-container').style.transform = `scale(1)`;
}

/* --- Map Render & Drag Logic --- */
const machinesMap = new Map();
function renderMapGrid() {
    window.mapRendered = true;
    for (let row = 1; row <= 4; row++) {
        const rowDiv = document.getElementById(`row${row}`);
        for (let col = 1; col <= 9; col++) {
            const idx = (row - 1) * 9 + col;
            const seatId = idx < 10 ? `M0${idx}` : `M${idx}`;
            
            let shiftClass = "";
            let isEvenIndex = (col - 1) % 2 === 0;
            if (row === 1 || row === 3) shiftClass = isEvenIndex ? "transform: translateY(24px);" : "transform: translateY(-24px);";
            else shiftClass = isEvenIndex ? "transform: translateY(-24px);" : "transform: translateY(24px);";

            const deskHTML = `
                <div id="desk-${seatId}" class="desk-node" style="${shiftClass}" onclick="openSeatModal('${seatId}')">
                    <div class="status-dot"></div>
                    <span class="desk-text">${seatId}</span>
                </div>
            `;
            rowDiv.insertAdjacentHTML('beforeend', deskHTML);
            machinesMap.set(seatId, { seat_id: seatId, status: 'offline', device: null });
        }
    }
    updateMap(devices);
}

const mapContainer = document.getElementById('map-container-wrapper');
let isDown = false, startX, startY, scrollLeft, scrollTop;
if(mapContainer) {
    mapContainer.addEventListener('mousedown', (e) => {
        isDown = true; startX = e.pageX - mapContainer.offsetLeft; startY = e.pageY - mapContainer.offsetTop;
        scrollLeft = mapContainer.scrollLeft; scrollTop = mapContainer.scrollTop;
    });
    mapContainer.addEventListener('mouseleave', () => { isDown = false; });
    mapContainer.addEventListener('mouseup', () => { isDown = false; });
    mapContainer.addEventListener('mousemove', (e) => {
        if(!isDown) return; e.preventDefault();
        const x = e.pageX - mapContainer.offsetLeft, y = e.pageY - mapContainer.offsetTop;
        mapContainer.scrollLeft = scrollLeft - (x - startX) * 1.5;
        mapContainer.scrollTop = scrollTop - (y - startY) * 1.5;
    });
}

function updateMap(data) {
    if (!window.mapRendered) return;
    // Reset all
    machinesMap.forEach(m => { m.status = 'offline'; m.device = null; });
    
    // Assign devices
    data.forEach(d => {
        if (d.seat_id) {
            const lastSeen = new Date(`${d.last_seen}Z`);
            const online = (Date.now() - lastSeen) < 5 * 60 * 1000;
            const m = machinesMap.get(d.seat_id);
            if (m) {
                m.status = online ? 'online' : 'offline';
                m.device = d;
            }
        }
    });

    // Update UI
    machinesMap.forEach((m, seatId) => {
        const deskEl = document.getElementById(`desk-${seatId}`);
        if (!deskEl) return;
        deskEl.className = 'desk-node ' + (m.device ? 'assigned ' : '') + m.status;
    });
}

/* --- Seat Modal Logic --- */
let currentSeatId = null;
let currentSeatDevice = null;
const seatModal = document.getElementById('seat-modal');

function openSeatModal(seatId) {
    currentSeatId = seatId;
    document.getElementById('modal-seat-title').textContent = `Vị trí Ghế: ${seatId}`;
    const m = machinesMap.get(seatId);
    
    if (m && m.device) {
        currentSeatDevice = m.device;
        document.getElementById('modal-unassigned-view').hidden = true;
        document.getElementById('modal-assigned-view').hidden = false;
        document.getElementById('modal-hostname').textContent = m.device.hostname || 'Unknown';
        document.getElementById('modal-rustdesk').textContent = m.device.id;
        document.getElementById('modal-password').textContent = m.device.pass;
        
        document.getElementById('btn-connect-rd').onclick = () => window.location.href = `rustdesk://connect?id=${encodeURIComponent(m.device.id)}`;
        document.getElementById('btn-chat-rd').onclick = () => openBossChat(m.device);
        document.getElementById('btn-unassign').onclick = () => doAssignSeat(m.device.id, null);
    } else {
        document.getElementById('modal-unassigned-view').hidden = false;
        document.getElementById('modal-assigned-view').hidden = true;
        
        const select = document.getElementById('unassigned-device-select');
        select.innerHTML = '<option value="">-- Chọn thiết bị --</option>';
        devices.forEach(d => {
            if (!d.seat_id) {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = `${d.hostname || 'Unknown'} (${d.id})`;
                select.appendChild(opt);
            }
        });
    }
    seatModal.hidden = false;
}

function closeSeatModal() { seatModal.hidden = true; }

function assignSeat() {
    const devId = document.getElementById('unassigned-device-select').value;
    if (!devId) return alert('Vui lòng chọn một thiết bị!');
    doAssignSeat(devId, currentSeatId);
}

async function doAssignSeat(deviceId, seatId) {
    try {
        const response = await fetch(`/api/admin/devices/${encodeURIComponent(deviceId)}/seat`, {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ seat_id: seatId })
        });
        if (!response.ok) throw new Error(await response.text());
        closeSeatModal();
        fetchDevices(); // Reload to reflect changes
    } catch (e) {
        alert('Lỗi cập nhật ghế: ' + e);
    }
}
