'use strict';

const $ = (selector) => document.querySelector(selector);
function savedHealthHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem('kiosk-health-history') || '[]');
    const freshAfter = Date.now() - 12 * 60 * 60 * 1000;
    return Array.isArray(saved) ? saved.filter((item) => item.measuredAt >= freshAfter).slice(-39) : [];
  } catch (_error) {
    return [];
  }
}
const state = {
  devices: [], alerts: [], keys: [], groups: [], logs: [], healthHistory: savedHealthHistory(),
  eventSource: null, refreshTimer: null, healthTimer: null,
  settings: {
    dashboard_refresh_seconds: 20, online_threshold_minutes: 5, health_refresh_seconds: 15,
    audit_retention_days: 180, chat_access_mode: 'open', device_registration_mode: 'open',
    sos_enabled: true, password_reporting_enabled: true, admin_allowed_ips: '',
  },
};
const chatWindows = new Map();
const loginView = $('#login-view');
const appView = $('#app');
const toast = $('#toast');
let toastTimer;
const mapView = {
  scale: 1,
  x: 0,
  y: 0,
  minScale: 0.22,
  maxScale: 1.8,
  initialized: false,
  rendered: false,
  dragging: false,
  moved: false,
  pointerId: null,
  suppressClickUntil: 0,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, className, handler) {
  const button = element('button', `button compact ${className}`, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function api(url, options = {}) {
  const request = { credentials: 'same-origin', ...options };
  if (request.body && !(request.body instanceof FormData)) {
    request.headers = { 'Content-Type': 'application/json', ...(request.headers || {}) };
  }
  const response = await fetch(url, request);
  if (response.status === 401 && url !== '/api/admin/session') showLogin();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch (_error) { /* response is not JSON */ }
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function showLogin(message = '') {
  clearTimeout(state.refreshTimer);
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  appView.hidden = true;
  loginView.hidden = false;
  $('#login-error').textContent = message;
}

function showDashboard() {
  loginView.hidden = true;
  appView.hidden = false;
  connectEvents();
  refreshAll();
}

function serverDate(value) {
  if (!value) return null;
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
}

function isOnline(device) {
  const lastSeen = serverDate(device.last_seen);
  return lastSeen && Date.now() - lastSeen.getTime() < state.settings.online_threshold_minutes * 60 * 1000;
}

function isActive(device) {
  return state.settings.chat_access_mode === 'open'
    || Boolean(device.access_key_id && Number(device.key_active) === 1);
}

function seatValues(select, selected = '', currentDeviceId = '') {
  select.replaceChildren(new Option('Chưa gán', ''));
  for (let number = 1; number <= 36; number += 1) {
    const seat = `M${String(number).padStart(2, '0')}`;
    const occupant = state.devices.find((device) => device.seat_id === seat && device.id !== currentDeviceId);
    const option = new Option(occupant ? `${seat} · ${occupant.hostname || occupant.id}` : seat, seat, false, seat === selected);
    option.disabled = Boolean(occupant);
    select.add(option);
  }
}

function seatDescription(seatId) {
  const number = Number.parseInt(String(seatId || '').replace(/\D/g, ''), 10);
  if (!number || number > 36) return 'Chưa gán vị trí';
  const row = number <= 9 ? 1 : number <= 18 ? 2 : number <= 27 ? 3 : 4;
  const position = row % 2 === 1 ? number - ((row - 1) * 9) : (row * 9) - number + 1;
  return `Dãy ${row} · vị trí ${position}/9`;
}

async function fetchDevices() {
  state.devices = await api('/api/admin/devices');
  renderDevices();
  renderMap();
  renderKeyDeviceOptions();
  renderEmergencyDeviceOptions();
  renderMetrics();
}

async function fetchAlerts() {
  state.alerts = await api('/api/admin/chat/alerts');
  renderAlerts();
  renderDevices();
  renderMap();
  renderMetrics();
}

async function fetchKeys() {
  state.keys = await api('/api/admin/device-keys');
  renderKeys();
}

async function fetchGroups() {
  state.groups = await api('/api/admin/device-groups');
  renderGroups();
  renderDevices();
}

async function fetchKeywords() {
  const result = await api('/api/admin/settings/keywords');
  $('#keywords-input').value = result.keywords || '';
}

async function fetchSystemSettings() {
  state.settings = await api('/api/admin/settings/system');
  $('#dashboard-refresh-seconds').value = state.settings.dashboard_refresh_seconds;
  $('#online-threshold-minutes').value = state.settings.online_threshold_minutes;
  $('#health-refresh-seconds').value = state.settings.health_refresh_seconds;
  $('#audit-retention-days').value = state.settings.audit_retention_days;
  $('#chat-access-mode').value = state.settings.chat_access_mode;
  $('#device-registration-mode').value = state.settings.device_registration_mode;
  $('#sos-enabled').checked = state.settings.sos_enabled;
  $('#password-reporting-enabled').checked = state.settings.password_reporting_enabled;
  $('#admin-allowed-ips').value = state.settings.admin_allowed_ips || '';
  $('#current-admin-ip').textContent = state.settings.current_admin_ip || '—';
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return [days && `${days} ngày`, hours && `${hours} giờ`, `${minutes} phút`].filter(Boolean).join(' ');
}

function fillHealthDetails(selector, entries) {
  const list = $(selector);
  list.replaceChildren();
  entries.forEach(([label, value]) => {
    list.append(element('dt', '', label), element('dd', '', String(value ?? '—')));
  });
}

function percentage(value, total) {
  return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
}

function renderHealthGauge(selector, value, label, detail, warnAt = 85) {
  const gauge = $(selector);
  const safeValue = Math.round(Math.max(0, Math.min(100, value || 0)));
  gauge.style.setProperty('--gauge-value', safeValue);
  gauge.classList.toggle('warning', safeValue >= warnAt);
  gauge.querySelector('strong').textContent = `${safeValue}%`;
  gauge.querySelector('span').textContent = label;
  gauge.querySelector('small').textContent = detail;
}

function renderHealthHistory() {
  const svg = $('#health-history-chart');
  const bandwidthSvg = $('#bandwidth-history-chart');
  const history = state.healthHistory;
  if (!history.length) return;
  const width = 720;
  const height = 180;
  const x = (index) => history.length === 1 ? width / 2 : (index / (history.length - 1)) * width;
  const pathFor = (key) => history.map((sample, index) => {
    const y = height - (Math.max(0, Math.min(100, sample[key])) / 100) * height;
    return `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const areaFor = (key) => `M0,${height} ${pathFor(key)} L${width},${height}Z`;
  const last = history.at(-1);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs><linearGradient id="ram-area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#8ca8ff" stop-opacity=".2"/><stop offset="1" stop-color="#8ca8ff" stop-opacity="0"/></linearGradient></defs>
    <g class="chart-grid"><path d="M0 0H720M0 45H720M0 90H720M0 135H720M0 180H720"/></g>
    <path class="chart-area ram" d="${areaFor('ram')}"/>
    <path class="chart-line cpu" d="${pathFor('cpu')}"/>
    <path class="chart-line ram" d="${pathFor('ram')}"/>
    <path class="chart-line disk" d="${pathFor('disk')}"/>
    <circle class="chart-dot cpu" cx="${x(history.length - 1)}" cy="${height - last.cpu / 100 * height}" r="4"/>
    <circle class="chart-dot ram" cx="${x(history.length - 1)}" cy="${height - last.ram / 100 * height}" r="4"/>
    <circle class="chart-dot disk" cx="${x(history.length - 1)}" cy="${height - last.disk / 100 * height}" r="4"/>
  `;
  const bandwidthSamples = history.filter((sample) => sample.networkAvailable);
  const maxRate = Math.max(1, ...bandwidthSamples.flatMap((sample) => [sample.rxRate, sample.txRate]));
  const bandwidthHeight = 100;
  const bandwidthPath = (key) => bandwidthSamples.map((sample, index) => {
    const pointX = bandwidthSamples.length === 1 ? width / 2 : index / (bandwidthSamples.length - 1) * width;
    const pointY = bandwidthHeight - (sample[key] / maxRate) * bandwidthHeight;
    return `${index ? 'L' : 'M'}${pointX.toFixed(1)},${pointY.toFixed(1)}`;
  }).join(' ');
  bandwidthSvg.setAttribute('viewBox', `0 0 ${width} ${bandwidthHeight}`);
  bandwidthSvg.innerHTML = bandwidthSamples.length ? `
    <g class="chart-grid"><path d="M0 0H720M0 50H720M0 100H720"/></g>
    <path class="chart-line download" d="${bandwidthPath('rxRate')}"/>
    <path class="chart-line upload" d="${bandwidthPath('txRate')}"/>
  ` : '<text x="360" y="58" text-anchor="middle">Cần thêm một lần đo để tính tốc độ</text>';
  $('#network-rate').textContent = last.networkAvailable
    ? `↓ ${formatBytes(last.rxRate)}/s · ↑ ${formatBytes(last.txRate)}/s`
    : 'Linux VPS sẽ hiển thị sau lần đo thứ hai';
}

function renderHealth(health) {
  const hostMemoryUsed = health.host.memory_total_bytes - health.host.memory_free_bytes;
  const diskUsed = health.host.disk_total_bytes - health.host.disk_free_bytes;
  const cpuPercent = percentage(health.host.load_average[0], health.host.cpu_count);
  const ramPercent = percentage(hostMemoryUsed, health.host.memory_total_bytes);
  const diskPercent = percentage(diskUsed, health.host.disk_total_bytes);
  const previous = state.healthHistory.at(-1);
  const measuredAt = Date.now();
  const elapsedSeconds = previous ? Math.max(1, (measuredAt - previous.measuredAt) / 1000) : 0;
  const networkAvailable = Boolean(previous)
    && Number.isFinite(health.traffic.rx_bytes) && Number.isFinite(previous.rxBytes);
  state.healthHistory.push({
    measuredAt, cpu: cpuPercent, ram: ramPercent, disk: diskPercent,
    rxBytes: health.traffic.rx_bytes, txBytes: health.traffic.tx_bytes,
    rxRate: networkAvailable ? Math.max(0, (health.traffic.rx_bytes - previous.rxBytes) / elapsedSeconds) : 0,
    txRate: networkAvailable ? Math.max(0, (health.traffic.tx_bytes - previous.txBytes) / elapsedSeconds) : 0,
    networkAvailable,
  });
  state.healthHistory = state.healthHistory.slice(-40);
  try { localStorage.setItem('kiosk-health-history', JSON.stringify(state.healthHistory)); } catch (_error) { /* optional cache */ }
  renderHealthGauge('#gauge-cpu', cpuPercent, 'CPU load', `${health.host.cpu_count} lõi · load ${Number(health.host.load_average[0]).toFixed(2)}`);
  renderHealthGauge('#gauge-ram', ramPercent, 'RAM VPS', `${formatBytes(hostMemoryUsed)} / ${formatBytes(health.host.memory_total_bytes)}`);
  renderHealthGauge('#gauge-disk', diskPercent, 'Ổ đĩa', `${formatBytes(diskUsed)} / ${formatBytes(health.host.disk_total_bytes)}`, 90);
  renderHealthHistory();
  const cards = [
    ['API', health.status === 'ok' ? 'Hoạt động' : 'Có lỗi', health.status === 'ok'],
    ['Thiết bị online', `${health.devices.online || 0}/${health.devices.total || 0}`, true],
    ['Cảnh báo mở', health.chat.open_alerts || 0, Number(health.chat.open_alerts) === 0],
    ['Backup', health.backup.cron_enabled ? 'Đang bật' : 'Đang tắt', !health.backup.cron_enabled || health.backup.last_action !== 'backup.failed'],
  ];
  const summary = $('#health-summary');
  summary.replaceChildren(...cards.map(([label, value, good]) => {
    const card = element('article', `health-card ${good ? 'good' : 'bad'}`);
    card.append(element('span', '', label), element('strong', '', value));
    return card;
  }));
  fillHealthDetails('#health-process', [
    ['PID', health.process.pid], ['Node.js', health.process.node], ['Uptime', formatDuration(health.process.uptime_seconds)],
    ['RAM process', formatBytes(health.process.rss_bytes)], ['Heap', `${formatBytes(health.process.heap_used_bytes)} / ${formatBytes(health.process.heap_total_bytes)}`],
  ]);
  fillHealthDetails('#health-host', [
    ['Hostname', health.host.hostname], ['Hệ điều hành', health.host.platform], ['CPU', `${health.host.cpu_count} lõi`],
    ['Load average', health.host.load_average.map((value) => Number(value).toFixed(2)).join(' / ')], ['Uptime VPS', formatDuration(health.host.uptime_seconds)],
  ]);
  fillHealthDetails('#health-data', [
    ['Database', formatBytes(health.database.bytes)], ['SQLite WAL', formatBytes(health.database.wal_bytes)],
    ['Tin nhắn đã lưu', health.chat.messages || 0], ['Audit rows', health.audit.total || 0],
  ]);
  fillHealthDetails('#health-services', [
    ['Realtime admin', health.traffic.realtime_admin_connections], ['Rate-limit buckets', health.traffic.rate_limit_buckets],
    ['Google Drive', health.backup.google_drive_configured ? 'Đã cấu hình' : 'Chưa cấu hình'],
    ['Backup cuối', health.backup.last_action ? `${auditLabels[health.backup.last_action] || health.backup.last_action} · ${serverDate(health.backup.last_at)?.toLocaleString('vi-VN') || ''}` : 'Chưa có'],
  ]);
  const failures = $('#health-failure-list');
  failures.replaceChildren();
  if (!health.recent_failures.length) failures.append(element('p', 'empty-health', 'Không có lỗi gần đây.'));
  health.recent_failures.forEach((failure) => {
    const item = element('article', 'health-failure');
    item.append(
      element('strong', '', auditLabels[failure.action] || failure.action),
      element('span', '', `${failure.actor_id || 'system'} · ${serverDate(failure.created_at)?.toLocaleString('vi-VN') || ''}`),
    );
    failures.append(item);
  });
}

async function fetchHealth() {
  clearTimeout(state.healthTimer);
  try {
    renderHealth(await api('/api/admin/system/health'));
  } catch (error) {
    notify(`Không thể đọc server health: ${error.message}`);
  } finally {
    if (!$('#tab-health').hidden) {
      state.healthTimer = setTimeout(fetchHealth, state.settings.health_refresh_seconds * 1000);
    }
  }
}

async function fetchLogs() {
  const params = new URLSearchParams({ limit: '300' });
  const action = $('#log-action-filter').value;
  const query = $('#log-search').value.trim();
  if (action !== 'all') params.set('action', action);
  if (query) params.set('query', query);
  state.logs = await api(`/api/admin/audit-logs?${params}`);
  renderLogs();
}

async function refreshAll({ quiet = false } = {}) {
  clearTimeout(state.refreshTimer);
  try {
    await Promise.all([fetchDevices(), fetchAlerts(), fetchKeys(), fetchGroups()]);
    if (!quiet) notify('Dữ liệu đã được cập nhật');
  } catch (error) {
    console.error(error);
    if (!appView.hidden) notify(`Không thể tải dữ liệu: ${error.message}`);
  } finally {
    state.refreshTimer = setTimeout(() => {
      if (!document.hidden && !appView.hidden) refreshAll({ quiet: true });
    }, state.settings.dashboard_refresh_seconds * 1000);
  }
}

function renderMetrics() {
  $('#metric-online').textContent = state.devices.filter(isOnline).length;
  $('#metric-alerts').textContent = state.alerts.length;
  $('#metric-active').textContent = state.devices.filter(isActive).length;
  $('#metric-pending').textContent = state.devices.filter((device) => !isActive(device)).length;
}

function renderDevices() {
  const body = $('#device-list');
  body.replaceChildren();
  const query = $('#search-input').value.trim().toLocaleLowerCase('vi');
  const statusFilter = $('#status-filter').value;
  const devices = state.devices.filter((device) => {
    const searchable = `${device.hostname || ''} ${device.id} ${device.seat_id || ''} ${device.key_label || ''}`.toLocaleLowerCase('vi');
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'online' && isOnline(device))
      || (statusFilter === 'pending' && !isActive(device))
      || (statusFilter === 'forced' && Number(device.key_entry_required) === 1)
      || (statusFilter === 'active' && isActive(device));
    return searchable.includes(query) && matchesStatus;
  });
  const sortMode = $('#device-sort')?.value || 'seat';
  devices.sort((left, right) => {
    if (sortMode === 'online') {
      const difference = Number(isOnline(right)) - Number(isOnline(left));
      if (difference) return difference;
    } else if (sortMode === 'updated') {
      const difference = (serverDate(right.last_seen)?.getTime() || 0) - (serverDate(left.last_seen)?.getTime() || 0);
      if (difference) return difference;
    } else if (sortMode === 'hostname') {
      const difference = (left.hostname || left.id).localeCompare(right.hostname || right.id, 'vi');
      if (difference) return difference;
    } else {
      const difference = (left.seat_id || 'ZZZ').localeCompare(right.seat_id || 'ZZZ', 'vi', { numeric: true });
      if (difference) return difference;
    }
    return (left.hostname || left.id).localeCompare(right.hostname || right.id, 'vi');
  });
  if (!devices.length) {
    const row = element('tr');
    const cell = element('td', 'empty-state', query ? 'Không tìm thấy thiết bị phù hợp.' : 'Chưa có thiết bị đăng ký.');
    cell.colSpan = 9;
    row.append(cell);
    body.append(row);
    return;
  }

  devices.forEach((device) => {
    const active = isActive(device);
    const online = isOnline(device);
    const forcedKey = Number(device.key_entry_required) === 1;
    const activeSos = state.alerts.some(
      (alert) => alert.device_id === device.id && alert.matched_keyword === 'hotkey-sos',
    );
    const row = element('tr', activeSos ? 'device-sos-active' : '');
    const connectionCell = element('td');
    connectionCell.append(element('span', `status ${online ? 'online' : 'offline'}`, online ? 'Online' : 'Offline'));
    if (activeSos) connectionCell.append(element('span', 'device-sos-badge', 'SOS'));

    const accessCell = element('td');
    accessCell.append(element(
      'span',
      `status ${active ? 'online' : 'pending'}`,
      active ? 'Đã mở' : (forcedKey ? 'Bắt nhập key' : 'Chờ admin'),
    ));

    const machineCell = element('td');
    const machine = element('div', 'device-name');
    machine.append(element('strong', '', device.hostname || 'Máy chưa đặt tên'));
    machine.append(element('small', '', active ? (device.key_label || 'Đã kích hoạt') : (forcedKey ? 'Máy đang hiện ô nhập key' : 'Chờ admin gán key')));
    if (device.device_tag) {
      const deviceTag = element('span', 'device-color-tag', device.device_tag);
      deviceTag.style.setProperty('--tag-color', device.tag_color || '#4ed8c3');
      machine.append(deviceTag);
    }
    const groupSelect = element('select', 'device-group-select');
    groupSelect.add(new Option('Không nhóm', ''));
    state.groups.forEach((group) => groupSelect.add(new Option(group.name, String(group.id))));
    groupSelect.value = device.group_id ? String(device.group_id) : '';
    groupSelect.title = 'Nhóm quản lý';
    groupSelect.addEventListener('change', () => assignDeviceGroup(device.id, groupSelect.value));
    machine.append(groupSelect);
    machineCell.append(machine);

    const idCell = element('td', 'mono', device.id);
    idCell.title = 'Nhấn để sao chép ID';
    idCell.addEventListener('click', () => copyValue(device.id, 'Đã sao chép RustDesk ID'));

    const passwordCell = element('td');
    const passwordButton = element('button', 'password-pill mono', device.pass ? '••••••' : 'Chưa có');
    passwordButton.type = 'button';
    passwordButton.disabled = !device.pass;
    passwordButton.title = device.pass ? 'Bấm để hiện hoặc ẩn mật khẩu' : 'Máy chưa gửi mật khẩu';
    let passwordVisible = false;
    passwordButton.addEventListener('click', () => {
      passwordVisible = !passwordVisible;
      passwordButton.textContent = passwordVisible ? device.pass : '••••••';
    });
    passwordCell.append(passwordButton);

    const seatCell = element('td');
    const seatSelect = element('select', 'seat-select');
    seatValues(seatSelect, device.seat_id || '', device.id);
    seatSelect.addEventListener('change', () => assignSeat(device.id, seatSelect.value || null));
    seatCell.append(seatSelect, element('small', 'seat-detail', seatDescription(device.seat_id)));

    const keyCell = element('td');
    keyCell.append(element('span', active ? 'key-badge' : 'key-badge pending', active ? (device.key_hint || 'Đã cấp') : 'Chưa cấp'));

    const lastCell = element('td', 'muted');
    const lastSeen = serverDate(device.last_seen);
    lastCell.textContent = lastSeen ? lastSeen.toLocaleString('vi-VN') : 'Chưa rõ';

    const actionsCell = element('td');
    const actions = element('div', 'row-actions');
    if (forcedKey) actions.append(actionButton('Gỡ ép key', 'ghost', () => cancelKeyRequirement([device.id])));
    if (!active && !forcedKey) actions.append(actionButton('Kích hoạt', 'primary', () => activateDevice(device)));
    if (active) {
      actions.append(actionButton('Nhập key lại', 'danger', () => requireNewKeys([device.id])));
      const chatButton = actionButton('Chat', 'ghost chat-action-button', () => openBossChat(device));
      const deviceAlerts = state.alerts.filter((alert) => alert.device_id === device.id);
      if (deviceAlerts.length) {
        const urgent = deviceAlerts.some((alert) => alert.priority === 'urgent');
        const chatCount = element('span', `chat-action-count ${urgent ? 'urgent' : ''}`);
        chatCount.textContent = deviceAlerts.length > 99 ? '99+' : String(deviceAlerts.length);
        chatButton.append(chatCount);
      }
      actions.append(chatButton);
    }
    const connect = element('a', 'button compact ghost', 'Kết nối');
    actions.append(actionButton('Tag', 'ghost', () => editDeviceTag(device)));
    connect.href = `rustdesk://connect?id=${encodeURIComponent(device.id)}`;
    actions.append(connect);
    actions.append(actionButton('Xóa', 'danger', () => deleteDevice(device)));
    actionsCell.append(actions);
    row.append(connectionCell, accessCell, machineCell, idCell, passwordCell, seatCell, keyCell, lastCell, actionsCell);
    body.append(row);
  });
}

const auditLabels = {
  'admin.login': 'Đăng nhập admin',
  'admin.logout': 'Đăng xuất admin',
  'device.register_or_heartbeat': 'Thiết bị cập nhật',
  'device.assign_seat': 'Gán chỗ ngồi',
  'device.delete': 'Xóa thiết bị',
  'device.require_key': 'Ép nhập key',
  'device.cancel_key_requirement': 'Gỡ ép nhập key',
  'key.create': 'Tạo key',
  'key.update': 'Sửa key',
  'key.revoke': 'Thu hồi key',
  'chat.device_message': 'Tin nhắn từ máy',
  'chat.admin_message': 'Tin nhắn từ admin',
  'chat.emergency_delete': 'Xóa chat khẩn cấp',
  'alert.acknowledge': 'Xử lý cảnh báo',
  'settings.update_keywords': 'Sửa từ khóa cảnh báo',
  'settings.update_system': 'Sửa cấu hình vận hành',
  'backup.success': 'Backup Google Drive thành công',
  'backup.failed': 'Backup Google Drive thất bại',
  'api.mutation': 'Thay đổi hệ thống',
};

function renderLogs() {
  const body = $('#audit-log-list');
  body.replaceChildren();
  if (!state.logs.length) {
    const row = element('tr');
    const cell = element('td', 'empty-state', 'Chưa có hoạt động phù hợp.');
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    return;
  }
  state.logs.forEach((log) => {
    const row = element('tr');
    const date = serverDate(log.created_at);
    row.append(element('td', 'muted mono', date ? date.toLocaleString('vi-VN') : '—'));
    const resultCell = element('td');
    resultCell.append(element('span', `status ${log.success ? 'online' : 'pending'}`, log.success ? 'Thành công' : 'Thất bại'));
    row.append(resultCell);
    row.append(element('td', 'audit-action', auditLabels[log.action] || log.action));
    row.append(element('td', 'mono', log.actor_id || log.actor_type));
    row.append(element('td', 'mono', log.entity_id || '—'));
    const details = log.details || {};
    const detailParts = [
      details.seat_id && `ghế ${details.seat_id}`,
      details.mode && `mode ${details.mode}`,
      details.channel && `kênh ${details.channel}`,
      details.device_ids?.length && `${details.device_ids.length} máy`,
      details.message_length !== undefined && `${details.message_length} ký tự`,
      details.status && `HTTP ${details.status}`,
    ].filter(Boolean);
    row.append(element('td', 'muted audit-detail', detailParts.join(' · ') || details.path || '—'));
    body.append(row);
  });
}

function renderAlerts() {
  const panel = $('#alert-panel');
  const list = $('#alert-list');
  list.replaceChildren();
  panel.hidden = state.alerts.length === 0;
  $('#alert-count').textContent = state.alerts.length;

  state.alerts.forEach((alert) => {
    const item = element('article', `chat-alert ${alert.priority === 'urgent' ? 'urgent' : ''}`);
    const details = element('div');
    const identity = element('div', 'alert-identity');
    identity.append(element('strong', '', alert.hostname || alert.device_id));
    if (alert.seat_id) identity.append(element('span', 'seat-badge', alert.seat_id));
    identity.append(element('span', `priority-badge ${alert.priority}`, alert.priority === 'urgent' ? 'Khẩn' : 'Tin mới'));
    const message = element('p', 'alert-message', alert.body);
    const createdAt = serverDate(alert.created_at);
    const metaParts = [alert.key_label || alert.key_hint || `ID ${alert.device_id}`];
    if (alert.matched_keyword) metaParts.push(`từ khóa “${alert.matched_keyword}”`);
    if (createdAt) metaParts.push(createdAt.toLocaleString('vi-VN'));
    const meta = element('div', 'alert-meta', metaParts.join(' · '));
    details.append(identity, message, meta);
    const actions = element('div', 'alert-actions');
    actions.append(actionButton('Mở chat', 'ghost', () => openBossChat({ id: alert.device_id, hostname: alert.hostname })));
    actions.append(actionButton('Đã xử lý', 'danger', () => acknowledgeAlert(alert.id)));
    item.append(details, actions);
    list.append(item);
  });
}

function renderMap() {
  const grid = $('#desk-grid');
  grid.replaceChildren();
  const bySeat = new Map(state.devices.filter((device) => device.seat_id).map((device) => [device.seat_id, device]));
  const roomRows = [
    { label: 'Dãy 4', seats: [36, 35, 34, 33, 32, 31, 30, 29, 28], photo: ['36', '31', '32', '30', '34', '29', '24.2', '24.1', '40'] },
    { label: 'Dãy 3', seats: [19, 20, 21, 22, 23, 24, 25, 26, 27], photo: ['02', '22', '26', 'K0', '23', '21', '11', '19', '10'] },
    { label: 'Dãy 2', seats: [18, 17, 16, 15, 14, 13, 12, 11, 10], photo: ['18', '09', '10', '12', '16', '24', '21', '22', '150'] },
    { label: 'Dãy 1', seats: [1, 2, 3, 4, 5, 6, 7, 8, 9], photo: ['10', '8', '30', '14', '7', '6', '1', 'K0', '05'] },
  ];

  const topWall = element('div', 'room-top-wall');
  topWall.append(
    element('span', 'rear-window window-one'),
    element('span', 'rear-window window-two'),
    element('span', 'server-cabinet', 'SERVER'),
  );

  const roomBody = element('div', 'room-body');
  const seatArea = element('div', 'seat-area');
  roomRows.forEach((roomRow) => {
    const row = element('section', 'room-row');
    row.append(element('h3', 'room-row-label', roomRow.label));
    const line = element('div', 'desk-line');
    roomRow.seats.forEach((seatNumber, index) => {
      const seat = `M${String(seatNumber).padStart(2, '0')}`;
      const device = bySeat.get(seat);
      const deskAlerts = device ? state.alerts.filter((alert) => alert.device_id === device.id) : [];
      const urgentAlerts = deskAlerts.filter((alert) => alert.priority === 'urgent');
      const sosAlerts = deskAlerts.filter((alert) => alert.matched_keyword === 'hotkey-sos');
      const status = !device ? '' : isOnline(device) ? 'online assigned' : 'offline assigned';
      const keyPending = Boolean(device && !isActive(device));
      const desk = element('button', `desk ${index % 2 === 0 ? 'upper' : 'lower'} ${status} ${sosAlerts.length ? 'has-sos-alert' : ''}`.trim());
      desk.type = 'button';
      desk.title = `${roomRow.label} · Số ảnh ${roomRow.photo[index]} · Ghế ${seat}`;

      const equipment = element('span', 'desk-equipment');
      equipment.append(element('i', 'desk-pc'), element('i', 'desk-monitor'), element('i', 'desk-chair'));
      const codes = element('span', 'desk-codes');
      const photoCode = element('span', 'desk-code photo-code');
      photoCode.append(element('small', '', 'SỐ ẢNH'), element('strong', '', roomRow.photo[index]));
      const seatCode = element('span', 'desk-code seat-code');
      seatCode.append(element('small', '', 'SỐ GHẾ'), element('strong', '', seat));
      codes.append(photoCode, seatCode);
      const deviceName = element('span', 'desk-device', device ? (device.hostname || device.id) : 'Chưa gán máy');
      desk.append(equipment, codes, deviceName);
      if (device?.device_tag) {
        const deviceTag = element('span', 'map-device-tag', device.device_tag);
        deviceTag.style.setProperty('--tag-color', device.tag_color || '#4ed8c3');
        desk.append(deviceTag);
      }
      if (keyPending) {
        const keyBadge = element('span', 'desk-key-badge', 'KEY');
        keyBadge.title = 'Máy đang chờ admin gán key';
        keyBadge.setAttribute('aria-label', keyBadge.title);
        desk.append(keyBadge);
      }
      if (deskAlerts.length) {
        const badge = element('span', `desk-alert-badge ${urgentAlerts.length ? 'urgent' : ''}`);
        badge.append(
          element('span', 'desk-alert-icon', '●'),
          element('strong', 'desk-alert-count', deskAlerts.length > 99 ? '99+' : String(deskAlerts.length)),
        );
        badge.title = sosAlerts.length
          ? `${sosAlerts.length} yêu cầu SOS · ${deskAlerts.length} tin chưa xử lý`
          : urgentAlerts.length
            ? `${urgentAlerts.length} tin khẩn · ${deskAlerts.length} tin chưa xử lý`
          : `${deskAlerts.length} tin chưa xử lý`;
        badge.setAttribute('aria-label', badge.title);
        desk.append(badge);
      }
      if (device) {
        const hover = element('span', 'desk-hover-card');
        [
          ['Máy', device.hostname || device.id],
          ['RustDesk ID', device.id],
          ['Ghế', seat],
          ['Kết nối', isOnline(device) ? 'Online' : 'Offline'],
          ['Key', isActive(device) ? (device.key_label || 'Đã mở') : 'Chưa cấp'],
          ['Tag', device.device_tag || 'Không có'],
          ['Cập nhật', serverDate(device.last_seen)?.toLocaleString('vi-VN') || 'Chưa rõ'],
        ].forEach(([label, value]) => {
          const line = element('span', 'desk-hover-line');
          line.append(element('small', '', label), element('strong', '', value));
          hover.append(line);
        });
        desk.append(hover);
      }
      const selectDesk = () => {
        grid.querySelector('.desk.selected')?.classList.remove('selected');
        desk.classList.add('selected');
      };
      desk.addEventListener('pointerdown', (event) => event.stopPropagation());
      desk.addEventListener('click', (event) => {
        selectDesk();
        if (event.detail === 0) openSeatModal(seat, device);
      });
      desk.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectDesk();
        openSeatModal(seat, device);
      });
      line.append(desk);
    });
    row.append(line);
    seatArea.append(row);
  });

  const serviceZone = element('aside', 'service-zone');
  serviceZone.append(
    element('div', 'teacher-desk', 'BÀN GV'),
    element('div', 'podium', 'BỤC GIẢNG'),
    element('div', 'storage-cabinet', 'TỦ GỖ'),
  );
  roomBody.append(seatArea, serviceZone);

  const bottomWall = element('div', 'room-bottom-wall');
  bottomWall.append(
    element('span', 'front-door', 'CỬA'),
    element('strong', 'room-sign', 'P204'),
    element('span', 'front-door', 'CỬA'),
  );
  grid.append(topWall, roomBody, bottomWall);
  if (!mapView.rendered) {
    mapView.rendered = true;
    requestAnimationFrame(fitMapView);
  }
}

function clampMapView() {
  const canvas = $('#map-canvas');
  const grid = $('#desk-grid');
  if (!canvas || !grid || !canvas.clientWidth || !grid.offsetWidth) return;
  const margin = 70;
  const renderedWidth = grid.offsetWidth * mapView.scale;
  const renderedHeight = grid.offsetHeight * mapView.scale;
  const clampAxis = (position, viewportSize, contentSize) => {
    if (contentSize > viewportSize) return Math.min(margin, Math.max(viewportSize - contentSize - margin, position));
    const centered = (viewportSize - contentSize) / 2;
    const freedom = Math.min(160, Math.max(55, (viewportSize - contentSize) / 2));
    return Math.min(centered + freedom, Math.max(centered - freedom, position));
  };
  mapView.x = clampAxis(mapView.x, canvas.clientWidth, renderedWidth);
  mapView.y = clampAxis(mapView.y, canvas.clientHeight, renderedHeight);
}

function applyMapView() {
  const grid = $('#desk-grid');
  if (!grid) return;
  clampMapView();
  grid.style.transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})`;
  $('#map-zoom-level').value = `${Math.round(mapView.scale * 100)}%`;
}

function fitMapView() {
  const canvas = $('#map-canvas');
  const grid = $('#desk-grid');
  if (!canvas || !grid || !canvas.clientWidth || !grid.offsetWidth) return;
  const padding = 28;
  mapView.scale = Math.max(mapView.minScale, Math.min(1, (canvas.clientWidth - padding * 2) / grid.offsetWidth, (canvas.clientHeight - padding * 2) / grid.offsetHeight));
  mapView.x = (canvas.clientWidth - grid.offsetWidth * mapView.scale) / 2;
  mapView.y = (canvas.clientHeight - grid.offsetHeight * mapView.scale) / 2;
  mapView.initialized = true;
  applyMapView();
}

function zoomMap(nextScale, clientX, clientY) {
  const canvas = $('#map-canvas');
  if (!canvas || !mapView.initialized) return;
  const rect = canvas.getBoundingClientRect();
  const localX = (clientX ?? (rect.left + rect.width / 2)) - rect.left;
  const localY = (clientY ?? (rect.top + rect.height / 2)) - rect.top;
  const worldX = (localX - mapView.x) / mapView.scale;
  const worldY = (localY - mapView.y) / mapView.scale;
  mapView.scale = Math.max(mapView.minScale, Math.min(mapView.maxScale, nextScale));
  mapView.x = localX - worldX * mapView.scale;
  mapView.y = localY - worldY * mapView.scale;
  applyMapView();
}

function setupMapInteractions() {
  const canvas = $('#map-canvas');
  const grid = $('#desk-grid');
  if (!canvas || !grid) return;

  $('#map-zoom-in').addEventListener('click', () => zoomMap(mapView.scale * 1.2));
  $('#map-zoom-out').addEventListener('click', () => zoomMap(mapView.scale / 1.2));
  $('#map-fit').addEventListener('click', fitMapView);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomMap(mapView.scale * (event.deltaY < 0 ? 1.06 : 1 / 1.06), event.clientX, event.clientY);
  }, { passive: false });
  canvas.addEventListener('dblclick', (event) => {
    if (event.target.closest('.desk, .map-controls')) return;
    event.preventDefault();
    zoomMap(mapView.scale * 1.35, event.clientX, event.clientY);
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.map-controls')) return;
    mapView.dragging = true;
    mapView.moved = false;
    mapView.pointerId = event.pointerId;
    mapView.startClientX = event.clientX;
    mapView.startClientY = event.clientY;
    mapView.startX = mapView.x;
    mapView.startY = mapView.y;
    canvas.classList.add('is-dragging');
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!mapView.dragging || event.pointerId !== mapView.pointerId) return;
    const deltaX = event.clientX - mapView.startClientX;
    const deltaY = event.clientY - mapView.startClientY;
    if (Math.hypot(deltaX, deltaY) > 4) mapView.moved = true;
    mapView.x = mapView.startX + deltaX;
    mapView.y = mapView.startY + deltaY;
    applyMapView();
  });
  const finishDrag = (event) => {
    if (!mapView.dragging || event.pointerId !== mapView.pointerId) return;
    if (mapView.moved) mapView.suppressClickUntil = performance.now() + 250;
    mapView.dragging = false;
    mapView.pointerId = null;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  grid.addEventListener('click', (event) => {
    if (performance.now() >= mapView.suppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  canvas.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 90 : 45;
    if (event.key === '+' || event.key === '=') zoomMap(mapView.scale * 1.2);
    else if (event.key === '-') zoomMap(mapView.scale / 1.2);
    else if (event.key === '0' || event.key === 'Home') fitMapView();
    else if (event.key === 'ArrowLeft') mapView.x += step;
    else if (event.key === 'ArrowRight') mapView.x -= step;
    else if (event.key === 'ArrowUp') mapView.y += step;
    else if (event.key === 'ArrowDown') mapView.y -= step;
    else return;
    event.preventDefault();
    applyMapView();
  });
  window.addEventListener('resize', () => {
    if (!$('#tab-map').hidden) fitMapView();
  });
}

function renderKeyDeviceOptions() {
  const select = $('#key-device');
  const selected = select.value;
  select.replaceChildren(new Option($('#key-mode').value === 'one_time' ? 'Không khóa trước vào máy' : 'Chọn máy cần kích hoạt…', ''));
  const sorted = [...state.devices].sort((a, b) => Number(isActive(a)) - Number(isActive(b)));
  sorted.forEach((device) => {
    const suffix = isActive(device) ? 'đã có key' : 'chờ key';
    select.add(new Option(`${device.hostname || device.id} · ${device.id} · ${suffix}`, device.id, false, device.id === selected));
  });
}

function renderEmergencyDeviceOptions() {
  const select = $('#emergency-chat-device');
  const selected = select.value;
  select.replaceChildren(new Option('Chọn một máy…', ''));
  [...state.devices]
    .sort((left, right) => (left.seat_id || 'ZZZ').localeCompare(right.seat_id || 'ZZZ'))
    .forEach((device) => {
      select.add(new Option(
        `${device.seat_id || 'Chưa gán'} · ${device.hostname || device.id} · ${device.id}`,
        device.id,
        false,
        device.id === selected,
      ));
    });
}

async function emergencyDeleteChat(scope, deviceId = null) {
  const selected = state.devices.find((device) => device.id === deviceId);
  const target = scope === 'all' ? 'TOÀN BỘ lịch sử chat' : `chat của ${selected?.hostname || deviceId}`;
  if (!window.confirm(`Xóa ${target}?\n\nHành động này không thể hoàn tác. Nhật ký xóa vẫn được giữ lại.`)) return;
  try {
    const result = await api('/api/admin/chat/messages', {
      method: 'DELETE',
      body: JSON.stringify({ scope, device_id: deviceId, confirmation: 'DELETE_CHAT' }),
    });
    if (scope === 'all') {
      chatWindows.forEach((windowElement) => windowElement.remove());
      chatWindows.clear();
    } else {
      const chatWindow = chatWindows.get(deviceId);
      if (chatWindow) {
        chatWindow.remove();
        chatWindows.delete(deviceId);
      }
    }
    notify(`Đã xóa ${result.deleted_messages} tin nhắn`);
    await Promise.all([fetchAlerts(), fetchLogs()]);
  } catch (error) {
    notify(`Không thể xóa chat: ${error.message}`);
  }
}

function renderKeys() {
  const list = $('#key-list');
  list.replaceChildren();
  $('#key-count').textContent = state.keys.filter((key) => Number(key.active) === 1).length;
  if (!state.keys.length) {
    list.append(element('div', 'empty-state', 'Chưa có key nào được tạo.'));
    return;
  }
  state.keys.forEach((key) => {
    const active = Number(key.active) === 1;
    const item = element('article', `key-item ${active ? '' : 'inactive'}`.trim());
    const main = element('div', 'key-item-main');
    const title = element('div', 'key-item-title');
    title.append(element('strong', '', key.label));
    title.append(element('span', 'key-badge', key.mode === 'one_time' ? (key.consumed_at ? 'Đã tự hủy' : 'Dùng một lần') : (active ? 'Đang dùng' : 'Đã thu hồi')));
    if (key.seat_id) title.append(element('span', 'seat-badge', key.seat_id));
    const meta = [key.key_hint, key.hostname || key.device_id || 'Chưa gắn máy'];
    if (key.created_at) meta.push(`tạo ${serverDate(key.created_at).toLocaleString('vi-VN')}`);
    main.append(title, element('div', 'key-item-meta', meta.join(' · ')));
    item.append(main);
    if (active) {
      const actions = element('div', 'key-item-actions');
      if (!key.consumed_at) actions.append(actionButton('Sửa key', '', () => showKeyEditor(key, item)));
      actions.append(actionButton('Thu hồi', 'danger', () => revokeKey(key.id)));
      item.append(actions);
    }
    list.append(item);
  });
}

function showKeyEditor(key, item) {
  item.querySelector('.key-edit-form')?.remove();
  const form = element('form', 'key-edit-form');
  const input = element('input', 'key-edit-input');
  input.type = 'text';
  input.name = 'key';
  input.required = true;
  input.minLength = 8;
  input.maxLength = 16;
  input.pattern = '[A-Za-z0-9]{8,16}';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Ví dụ: p20401034';
  input.setAttribute('aria-label', 'Mã key mới');
  if (/^[a-z0-9]{8,16}$/i.test(key.key_hint || '')) input.value = key.key_hint.toLowerCase();
  input.addEventListener('input', () => {
    input.value = input.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  });
  const save = actionButton('Lưu key', 'primary', () => {});
  save.type = 'submit';
  const cancel = actionButton('Hủy', '', () => form.remove());
  form.append(input, save, cancel);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await api(`/api/admin/device-keys/${key.id}`, {
        method: 'PUT', body: JSON.stringify({ key: input.value }),
      });
      showGeneratedKey(result.key);
      notify(`Đã đổi key thành ${result.key}`);
      await fetchKeys();
    } catch (error) { notify(`Không sửa được key: ${error.message}`); }
    finally { save.disabled = false; }
  });
  item.append(form);
  input.focus();
}

async function assignSeat(deviceId, seatId) {
  try {
    await api(`/api/admin/devices/${encodeURIComponent(deviceId)}/seat`, {
      method: 'POST', body: JSON.stringify({ seat_id: seatId }),
    });
    notify(seatId ? `Đã gán máy vào ${seatId}` : 'Đã bỏ gán chỗ ngồi');
    await fetchDevices();
    if ($('#seat-modal').open) $('#seat-modal').close();
  } catch (error) {
    notify(`Không cập nhật được chỗ ngồi: ${error.message}`);
    await fetchDevices();
  }
}

async function editDeviceTag(device) {
  const tag = window.prompt('Tên tag ngắn (để trống để xóa):', device.device_tag || '');
  if (tag === null) return;
  const color = tag.trim()
    ? window.prompt('Màu tag dạng HEX:', device.tag_color || '#4ed8c3')
    : '#4ed8c3';
  if (color === null) return;
  if (!/^#[0-9a-f]{6}$/i.test(color)) return notify('Màu tag phải có dạng #RRGGBB');
  try {
    await api(`/api/admin/devices/${encodeURIComponent(device.id)}/tag`, {
      method: 'POST',
      body: JSON.stringify({ tag: tag.trim(), color }),
    });
    notify(tag.trim() ? 'Đã cập nhật tag máy' : 'Đã xóa tag máy');
    await fetchDevices();
  } catch (error) {
    notify(`Không thể cập nhật tag: ${error.message}`);
  }
}

function renderGroups() {
  const list = $('#device-group-list');
  if (!list) return;
  list.replaceChildren();
  if (!state.groups.length) {
    list.append(element('p', 'empty-health', 'Chưa có nhóm máy.'));
    return;
  }
  state.groups.forEach((group) => {
    const item = element('article', 'device-group-card');
    const dot = element('i', 'group-color-dot');
    dot.style.background = group.color;
    const info = element('div');
    info.append(element('strong', '', group.name), element('small', '', `${group.device_count} máy`));
    const actions = element('div', 'row-actions');
    actions.append(
      actionButton('Sửa', 'ghost', () => editDeviceGroup(group)),
      actionButton('Xóa', 'danger', () => deleteDeviceGroup(group)),
    );
    item.append(dot, info, actions);
    list.append(item);
  });
}

async function assignDeviceGroup(deviceId, groupId) {
  try {
    await api(`/api/admin/devices/${encodeURIComponent(deviceId)}/group`, {
      method: 'POST',
      body: JSON.stringify({ group_id: groupId || null }),
    });
    notify('Đã cập nhật nhóm máy');
    await Promise.all([fetchDevices(), fetchGroups()]);
  } catch (error) {
    notify(`Không thể gán nhóm: ${error.message}`);
  }
}

async function editDeviceGroup(group) {
  const name = window.prompt('Tên nhóm:', group.name);
  if (!name?.trim()) return;
  const color = window.prompt('Màu nhóm dạng HEX:', group.color);
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return notify('Màu nhóm phải có dạng #RRGGBB');
  try {
    await api(`/api/admin/device-groups/${group.id}`, {
      method: 'PUT', body: JSON.stringify({ name: name.trim(), color }),
    });
    await Promise.all([fetchGroups(), fetchDevices()]);
  } catch (error) { notify(`Không thể sửa nhóm: ${error.message}`); }
}

async function deleteDeviceGroup(group) {
  if (!window.confirm(`Xóa nhóm “${group.name}”? Máy trong nhóm sẽ chuyển về Không nhóm.`)) return;
  try {
    await api(`/api/admin/device-groups/${group.id}`, { method: 'DELETE' });
    await Promise.all([fetchGroups(), fetchDevices()]);
  } catch (error) { notify(`Không thể xóa nhóm: ${error.message}`); }
}

async function deleteDevice(device) {
  const label = device.hostname || device.id;
  if (!window.confirm(`Xóa ${label} khỏi hệ thống?\n\nKey hiện tại sẽ bị thu hồi. Lịch sử chat và nhật ký vẫn được giữ lại.`)) return;
  try {
    await api(`/api/admin/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    const chatWindow = chatWindows.get(device.id);
    if (chatWindow) {
      chatWindow.remove();
      chatWindows.delete(device.id);
    }
    notify(`Đã xóa ${label}`);
    await Promise.all([fetchDevices(), fetchKeys(), fetchLogs()]);
  } catch (error) {
    notify(`Không thể xóa máy: ${error.message}`);
  }
}

async function activateDevice(device) {
  const seat = device.seat_id || window.prompt('Chỗ ngồi cho máy (có thể để trống):', '') || '';
  try {
    const result = await createKey({
      mode: 'bound', device_id: device.id, seat_id: seat || null,
      label: seat ? `${seat} · ${device.hostname || device.id}` : (device.hostname || device.id),
    });
    showGeneratedKey(result.key);
    notify(`Đã kích hoạt chat cho ${device.hostname || device.id}`);
    await Promise.all([fetchDevices(), fetchKeys()]);
  } catch (error) { notify(`Không kích hoạt được máy: ${error.message}`); }
}

async function createKey(payload) {
  return api('/api/admin/device-keys', { method: 'POST', body: JSON.stringify(payload) });
}

async function requireNewKeys(deviceIds = null) {
  const allDevices = !deviceIds;
  const prompt = allDevices
    ? `Buộc toàn bộ ${state.devices.length} máy nhập key mới? Mỗi máy sẽ có một key tự hủy riêng.`
    : 'Buộc máy này nhập key mới? Quyền chat hiện tại sẽ bị khóa ngay.';
  if (!window.confirm(prompt)) return;
  try {
    const result = await api('/api/admin/devices/require-key', {
      method: 'POST',
      body: JSON.stringify(allDevices ? { scope: 'all' } : { device_ids: deviceIds }),
    });
    const lines = result.generated.map((item) => `${item.seat_id || item.hostname || item.device_id}: ${item.key}`);
    showGeneratedKey(lines.join('\n'));
    switchTab('keys');
    notify(`Đã khóa ${result.generated.length} máy và sinh key tự hủy`);
    await Promise.all([fetchDevices(), fetchKeys()]);
  } catch (error) { notify(`Không thể yêu cầu nhập key: ${error.message}`); }
}

async function cancelKeyRequirement(deviceIds = null) {
  const allDevices = !deviceIds;
  const forcedCount = state.devices.filter((device) => Number(device.key_entry_required) === 1).length;
  if (allDevices && forcedCount === 0) return notify('Không có máy nào đang bị ép nhập key');
  const prompt = allDevices
    ? `Gỡ yêu cầu nhập key cho ${forcedCount} máy? Các máy sẽ được mở chat tự động và vẫn giữ nguyên ghế.`
    : 'Gỡ yêu cầu nhập key cho máy này và mở lại chat tự động?';
  if (!window.confirm(prompt)) return;
  try {
    const result = await api('/api/admin/devices/cancel-key-requirement', {
      method: 'POST',
      body: JSON.stringify(allDevices ? { scope: 'all' } : { device_ids: deviceIds }),
    });
    notify(`Đã gỡ ép nhập key cho ${result.updated} máy`);
    await Promise.all([fetchDevices(), fetchKeys()]);
  } catch (error) { notify(`Không thể gỡ ép key: ${error.message}`); }
}

function showGeneratedKey(key) {
  $('#generated-key').textContent = key;
  $('#key-result').hidden = false;
}

async function revokeKey(id) {
  if (!window.confirm('Thu hồi key này? Máy gắn với key sẽ mất quyền chat.')) return;
  try {
    await api(`/api/admin/device-keys/${id}/revoke`, { method: 'POST' });
    notify('Đã thu hồi key');
    await Promise.all([fetchDevices(), fetchKeys()]);
  } catch (error) { notify(`Không thu hồi được key: ${error.message}`); }
}

function openBossChat(device) {
  const existing = chatWindows.get(device.id);
  if (existing) {
    existing.classList.remove('minimized');
    existing.classList.add('attention');
    setTimeout(() => existing.classList.remove('attention'), 500);
    return;
  }
  const url = new URL('/boss-chat.html', window.location.origin);
  url.searchParams.set('device_id', device.id);
  url.searchParams.set('hostname', device.hostname || device.id);
  const windowElement = element('article', 'chat-window');
  const header = element('header', 'chat-window-header');
  const identity = element('button', 'chat-window-identity');
  identity.type = 'button';
  identity.title = 'Thu nhỏ hoặc mở rộng';
  identity.append(element('i'), element('span', '', device.hostname || device.id));
  const controls = element('div', 'chat-window-controls');
  const popout = element('button', '', '↗');
  popout.type = 'button';
  popout.title = 'Mở thành cửa sổ riêng';
  const minimize = element('button', '', '−');
  minimize.type = 'button';
  minimize.title = 'Thu nhỏ';
  const close = element('button', '', '×');
  close.type = 'button';
  close.title = 'Đóng chat';
  controls.append(popout, minimize, close);
  header.append(identity, controls);
  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = `Chat với ${device.hostname || device.id}`;
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
  windowElement.append(header, frame);
  const toggle = () => windowElement.classList.toggle('minimized');
  identity.addEventListener('click', toggle);
  minimize.addEventListener('click', toggle);
  popout.addEventListener('click', () => {
    window.open(url, `chat-${device.id}`, 'popup,width=430,height=650');
    chatWindows.delete(device.id);
    windowElement.remove();
  });
  close.addEventListener('click', () => {
    chatWindows.delete(device.id);
    windowElement.remove();
  });
  chatWindows.set(device.id, windowElement);
  $('#chat-dock').append(windowElement);
}

async function acknowledgeAlert(id) {
  try {
    await api(`/api/admin/chat/alerts/${id}/acknowledge`, { method: 'POST' });
    state.alerts = state.alerts.filter((alert) => alert.id !== id);
    renderAlerts();
    renderMap();
    renderMetrics();
  } catch (error) { notify(`Không xử lý được cảnh báo: ${error.message}`); }
}

function openSeatModal(seat, device) {
  const dialog = $('#seat-modal');
  $('#modal-seat-title').textContent = seat;
  const content = $('#modal-content');
  content.replaceChildren();
  if (device) {
    const wrapper = element('div', 'modal-device');
    const info = element('div', 'modal-info');
    [['Máy', device.hostname || 'Chưa đặt tên'], ['RustDesk ID', device.id], ['Mật khẩu', device.pass || 'Chưa có'], ['Chat key', isActive(device) ? (device.key_label || 'Đã cấp') : 'Chờ kích hoạt']].forEach(([label, value]) => {
      info.append(element('span', '', label), element('strong', label === 'RustDesk ID' ? 'mono' : '', value));
    });
    const actions = element('div', 'modal-actions');
    if (Number(device.key_entry_required) === 1) {
      actions.append(actionButton('Gỡ ép key', 'ghost', () => cancelKeyRequirement([device.id])));
    } else if (!isActive(device)) {
      actions.append(actionButton('Kích hoạt chat', 'primary', () => activateDevice(device)));
    }
    if (isActive(device)) actions.append(actionButton('Mở chat', 'ghost', () => openBossChat(device)));
    const connect = element('a', 'button compact ghost', 'Kết nối RustDesk');
    connect.href = `rustdesk://connect?id=${encodeURIComponent(device.id)}`;
    actions.append(actionButton('Bỏ gán ghế', 'danger', () => assignSeat(device.id, null)), connect);
    wrapper.append(info, actions);
    content.append(wrapper);
  } else {
    const wrapper = element('div', 'modal-device');
    const copy = element('p', 'muted', 'Chọn một máy chưa có vị trí để gán vào chỗ này.');
    const select = element('select');
    select.append(new Option('Chọn thiết bị…', ''));
    state.devices.filter((item) => !item.seat_id).forEach((item) => select.add(new Option(`${item.hostname || item.id} · ${item.id}`, item.id)));
    const button = actionButton('Gán vào chỗ này', 'primary', () => {
      if (select.value) assignSeat(select.value, seat);
    });
    wrapper.append(copy, select, button);
    content.append(wrapper);
  }
  dialog.showModal();
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/admin/events');
  state.eventSource = source;
  source.addEventListener('ready', () => {
    $('#realtime-status').classList.remove('disconnected');
    $('#realtime-status').lastChild.textContent = ' Realtime';
  });
  source.addEventListener('chat-alert', (event) => {
    const alert = JSON.parse(event.data);
    notify(`${alert.seat_id || alert.hostname}: ${alert.body}`);
    if (Notification.permission === 'granted') {
      const browserNotice = new Notification(`${alert.priority === 'urgent' ? 'Khẩn · ' : ''}${alert.seat_id || alert.hostname}`, { body: alert.body, tag: `chat-${alert.device_id}` });
      browserNotice.onclick = () => { window.focus(); openBossChat({ id: alert.device_id, hostname: alert.hostname }); };
    }
    fetchAlerts().catch(console.error);
  });
  source.addEventListener('device-sos', () => fetchAlerts().catch(console.error));
  ['device-pending', 'device-activated', 'device-updated', 'device-key-updated', 'device-key-revoked'].forEach((eventName) => {
    source.addEventListener(eventName, () => Promise.all([fetchDevices(), fetchKeys()]).catch(console.error));
  });
  source.addEventListener('device-group-updated', () => Promise.all([fetchGroups(), fetchDevices()]).catch(console.error));
  source.addEventListener('device-deleted', () => Promise.all([fetchDevices(), fetchKeys()]).catch(console.error));
  source.addEventListener('audit-created', () => {
    if (!$('#tab-logs').hidden) fetchLogs().catch(console.error);
  });
  source.addEventListener('chat-deleted', () => fetchAlerts().catch(console.error));
  source.addEventListener('alert-acknowledged', () => fetchAlerts().catch(console.error));
  source.onerror = () => {
    $('#realtime-status').classList.add('disconnected');
    $('#realtime-status').lastChild.textContent = ' Đang nối lại';
  };
}

async function copyValue(value, message) {
  try { await navigator.clipboard.writeText(value); notify(message); }
  catch (_error) { notify('Trình duyệt không cho phép sao chép tự động'); }
}

function switchTab(tab) {
  document.querySelectorAll('.tab-button').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== `tab-${tab}`; });
  history.replaceState(null, '', `#${tab}`);
  if (tab === 'map') requestAnimationFrame(() => mapView.initialized ? applyMapView() : fitMapView());
  if (tab === 'logs') fetchLogs().catch((error) => notify(`Không thể tải nhật ký: ${error.message}`));
  if (tab === 'health') fetchHealth();
  else clearTimeout(state.healthTimer);
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/admin/session', { method: 'POST', body: JSON.stringify({ password: $('#admin-password').value }) });
    $('#admin-password').value = '';
    showDashboard();
    await Promise.all([fetchKeywords(), fetchSystemSettings()]);
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/admin/session', { method: 'DELETE' }); } catch (_error) { /* session may already be expired */ }
  showLogin();
});
$('#notification-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) return notify('Trình duyệt này không hỗ trợ thông báo hệ thống');
  const permission = await Notification.requestPermission();
  $('#notification-btn').textContent = permission === 'granted' ? 'Thông báo đã bật' : 'Bật thông báo';
  notify(permission === 'granted' ? 'Thông báo hệ thống đã bật' : 'Bạn chưa cho phép thông báo');
});
$('#refresh-btn').addEventListener('click', () => refreshAll());
$('#hero-refresh-btn').addEventListener('click', () => refreshAll());
$('#require-all-keys-btn').addEventListener('click', () => requireNewKeys());
$('#cancel-all-keys-btn').addEventListener('click', () => cancelKeyRequirement());
const deviceSort = element('select');
deviceSort.id = 'device-sort';
[
  ['seat', 'Cố định theo ghế'],
  ['hostname', 'Theo tên máy'],
  ['online', 'Online trước'],
  ['updated', 'Mới cập nhật'],
].forEach(([value, label]) => deviceSort.add(new Option(label, value)));
const deviceSortControl = element('label', 'filter-control');
deviceSortControl.title = 'Sắp xếp thiết bị';
deviceSortControl.append(deviceSort);
$('#require-all-keys-btn').before(deviceSortControl);
deviceSort.addEventListener('change', renderDevices);
$('#search-input').addEventListener('input', renderDevices);
$('#status-filter').addEventListener('change', renderDevices);
$('#settings-preset').addEventListener('change', (event) => {
  const presets = {
    balanced: { dashboard: 20, health: 15, online: 5, retention: 180, registration: 'open' },
    realtime: { dashboard: 5, health: 5, online: 2, retention: 90, registration: 'open' },
    economy: { dashboard: 60, health: 60, online: 10, retention: 90, registration: 'open' },
    locked: { dashboard: 20, health: 15, online: 5, retention: 180, registration: 'closed' },
  };
  const preset = presets[event.target.value];
  if (!preset) return;
  $('#dashboard-refresh-seconds').value = preset.dashboard;
  $('#health-refresh-seconds').value = preset.health;
  $('#online-threshold-minutes').value = preset.online;
  $('#audit-retention-days').value = preset.retention;
  $('#device-registration-mode').value = preset.registration;
  notify('Đã áp dụng preset. Bấm Lưu cấu hình để xác nhận.');
});
$('#device-group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#device-group-name').value.trim();
  const color = $('#device-group-color').value;
  if (!name) return notify('Hãy nhập tên nhóm');
  try {
    await api('/api/admin/device-groups', {
      method: 'POST', body: JSON.stringify({ name, color }),
    });
    $('#device-group-name').value = '';
    notify('Đã tạo nhóm máy');
    await fetchGroups();
  } catch (error) { notify(`Không thể tạo nhóm: ${error.message}`); }
});
document.querySelectorAll('.tab-button').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#refresh-logs-btn').addEventListener('click', () => fetchLogs());
$('#refresh-health-btn').addEventListener('click', () => fetchHealth());
$('#log-action-filter').addEventListener('change', () => fetchLogs());
let logSearchTimer;
$('#log-search').addEventListener('input', () => {
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => fetchLogs().catch(console.error), 280);
});
$('#delete-device-chat-btn').addEventListener('click', () => {
  const deviceId = $('#emergency-chat-device').value;
  if (!deviceId) return notify('Hãy chọn máy cần xóa lịch sử chat');
  emergencyDeleteChat('device', deviceId);
});
$('#delete-all-chat-btn').addEventListener('click', () => emergencyDeleteChat('all'));

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (event.key === '/' && !editing && !appView.hidden) {
    event.preventDefault();
    switchTab('devices');
    $('#search-input').focus();
  } else if (event.key === 'Escape' && $('#seat-modal').open) {
    $('#seat-modal').close();
  } else if (!editing && ['1', '2', '3', '4', '5', '6', '7'].includes(event.key)) {
    switchTab(['devices', 'map', 'groups', 'keys', 'settings', 'logs', 'health'][Number(event.key) - 1]);
  }
});

$('#key-mode').addEventListener('change', () => {
  const oneTime = $('#key-mode').value === 'one_time';
  $('#key-device').required = !oneTime;
  renderKeyDeviceOptions();
});
$('#key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = $('#key-mode').value;
  const deviceId = $('#key-device').value || null;
  if (mode === 'bound' && !deviceId) return notify('Hãy chọn máy cần kích hoạt');
  const selectedDevice = state.devices.find((device) => device.id === deviceId);
  const payload = {
    mode,
    device_id: deviceId,
    seat_id: $('#key-seat').value.trim() || null,
    label: $('#key-label').value.trim() || (mode === 'one_time' ? 'Key hỗ trợ một lần' : (selectedDevice?.hostname || deviceId)),
  };
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await createKey(payload);
    showGeneratedKey(result.key);
    notify(mode === 'one_time' ? 'Đã sinh key tự hủy' : 'Đã sinh key và kích hoạt máy');
    await Promise.all([fetchDevices(), fetchKeys()]);
  } catch (error) { notify(`Không tạo được key: ${error.message}`); }
  finally { button.disabled = false; }
});
$('#copy-key-btn').addEventListener('click', () => copyValue($('#generated-key').textContent, 'Đã sao chép key'));

$('#keyword-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#settings-message');
  try {
    const result = await api('/api/admin/settings/keywords', { method: 'POST', body: JSON.stringify({ keywords: $('#keywords-input').value }) });
    $('#keywords-input').value = result.keywords;
    message.className = 'form-message success';
    message.textContent = 'Đã lưu cấu hình.';
  } catch (error) {
    message.className = 'form-message danger';
    message.textContent = error.message;
  }
});

$('#system-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#system-settings-message');
  try {
    state.settings = await api('/api/admin/settings/system', {
      method: 'POST',
      body: JSON.stringify({
        dashboard_refresh_seconds: Number($('#dashboard-refresh-seconds').value),
        online_threshold_minutes: Number($('#online-threshold-minutes').value),
        health_refresh_seconds: Number($('#health-refresh-seconds').value),
        audit_retention_days: Number($('#audit-retention-days').value),
        chat_access_mode: $('#chat-access-mode').value,
        device_registration_mode: $('#device-registration-mode').value,
        sos_enabled: $('#sos-enabled').checked,
        password_reporting_enabled: $('#password-reporting-enabled').checked,
        admin_allowed_ips: $('#admin-allowed-ips').value,
      }),
    });
    message.className = 'form-message success';
    message.textContent = 'Đã lưu cấu hình vận hành.';
    renderDevices();
    renderMetrics();
    fetchHealth();
  } catch (error) {
    message.className = 'form-message danger';
    message.textContent = error.message;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !appView.hidden) refreshAll({ quiet: true });
});

setupMapInteractions();

(async function bootstrap() {
  try {
    await api('/api/admin/session');
    showDashboard();
    await Promise.all([fetchKeywords(), fetchSystemSettings()]);
    const initialTab = ['devices', 'map', 'groups', 'keys', 'settings', 'logs', 'health'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'devices';
    switchTab(initialTab);
  } catch (_error) { showLogin(); }
}());
