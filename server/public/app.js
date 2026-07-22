'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { devices: [], alerts: [], keys: [], eventSource: null, refreshTimer: null };
const loginView = $('#login-view');
const appView = $('#app');
const toast = $('#toast');
let toastTimer;

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
  return lastSeen && Date.now() - lastSeen.getTime() < 5 * 60 * 1000;
}

function isActive(device) {
  return Boolean(device.access_key_id && Number(device.key_active) === 1);
}

function seatValues(select, selected = '') {
  select.replaceChildren(new Option('Chưa gán', ''));
  for (let number = 1; number <= 36; number += 1) {
    const seat = `M${String(number).padStart(2, '0')}`;
    select.add(new Option(seat, seat, false, seat === selected));
  }
}

async function fetchDevices() {
  state.devices = await api('/api/admin/devices');
  renderDevices();
  renderMap();
  renderKeyDeviceOptions();
  renderMetrics();
}

async function fetchAlerts() {
  state.alerts = await api('/api/admin/chat/alerts');
  renderAlerts();
  renderMetrics();
}

async function fetchKeys() {
  state.keys = await api('/api/admin/device-keys');
  renderKeys();
}

async function fetchKeywords() {
  const result = await api('/api/admin/settings/keywords');
  $('#keywords-input').value = result.keywords || '';
}

async function refreshAll({ quiet = false } = {}) {
  clearTimeout(state.refreshTimer);
  try {
    await Promise.all([fetchDevices(), fetchAlerts(), fetchKeys()]);
    if (!quiet) notify('Dữ liệu đã được cập nhật');
  } catch (error) {
    console.error(error);
    if (!appView.hidden) notify(`Không thể tải dữ liệu: ${error.message}`);
  } finally {
    state.refreshTimer = setTimeout(() => {
      if (!document.hidden && !appView.hidden) refreshAll({ quiet: true });
    }, 20_000);
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
  const devices = state.devices.filter((device) => {
    const searchable = `${device.hostname || ''} ${device.id} ${device.seat_id || ''} ${device.key_label || ''}`.toLocaleLowerCase('vi');
    return searchable.includes(query);
  });
  if (!devices.length) {
    const row = element('tr');
    const cell = element('td', 'empty-state', query ? 'Không tìm thấy thiết bị phù hợp.' : 'Chưa có thiết bị đăng ký.');
    cell.colSpan = 7;
    row.append(cell);
    body.append(row);
    return;
  }

  devices.forEach((device) => {
    const active = isActive(device);
    const online = isOnline(device);
    const forcedKey = Number(device.key_entry_required) === 1;
    const row = element('tr');
    const statusCell = element('td');
    statusCell.append(element('span', `status ${active ? (online ? 'online' : 'offline') : 'pending'}`, active ? (online ? 'Online' : 'Offline') : (forcedKey ? 'Bắt nhập key' : 'Chờ key')));

    const machineCell = element('td');
    const machine = element('div', 'device-name');
    machine.append(element('strong', '', device.hostname || 'Máy chưa đặt tên'));
    machine.append(element('small', '', active ? (device.key_label || 'Đã kích hoạt') : (forcedKey ? 'Máy đang hiện ô nhập key' : 'Chờ admin gán key')));
    machineCell.append(machine);

    const idCell = element('td', 'mono', device.id);
    idCell.title = 'Nhấn để sao chép ID';
    idCell.addEventListener('click', () => copyValue(device.id, 'Đã sao chép RustDesk ID'));

    const seatCell = element('td');
    const seatSelect = element('select', 'seat-select');
    seatValues(seatSelect, device.seat_id || '');
    seatSelect.addEventListener('change', () => assignSeat(device.id, seatSelect.value || null));
    seatCell.append(seatSelect);

    const keyCell = element('td');
    keyCell.append(element('span', active ? 'key-badge' : 'key-badge pending', active ? (device.key_hint || 'Đã cấp') : 'Chưa cấp'));

    const lastCell = element('td', 'muted');
    const lastSeen = serverDate(device.last_seen);
    lastCell.textContent = lastSeen ? lastSeen.toLocaleString('vi-VN') : 'Chưa rõ';

    const actionsCell = element('td');
    const actions = element('div', 'row-actions');
    if (!active) actions.append(actionButton('Kích hoạt', 'primary', () => activateDevice(device)));
    if (active) {
      actions.append(actionButton('Nhập key lại', 'danger', () => requireNewKeys([device.id])));
      actions.append(actionButton('Chat', 'ghost', () => openBossChat(device)));
    }
    const connect = element('a', 'button compact ghost', 'Kết nối');
    connect.href = `rustdesk://connect?id=${encodeURIComponent(device.id)}`;
    actions.append(connect);
    actionsCell.append(actions);
    row.append(statusCell, machineCell, idCell, seatCell, keyCell, lastCell, actionsCell);
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
  for (let number = 1; number <= 36; number += 1) {
    const seat = `M${String(number).padStart(2, '0')}`;
    const device = bySeat.get(seat);
    const status = !device ? '' : !isActive(device) ? 'pending assigned' : isOnline(device) ? 'online assigned' : 'offline assigned';
    const desk = element('button', `desk ${status}`.trim());
    desk.type = 'button';
    desk.append(element('strong', '', seat));
    desk.append(element('small', '', device ? (device.hostname || device.id) : 'Chưa gán'));
    desk.addEventListener('click', () => openSeatModal(seat, device));
    grid.append(desk);
  }
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
    if (active) item.append(actionButton('Thu hồi', 'danger', () => revokeKey(key.id)));
    list.append(item);
  });
}

async function assignSeat(deviceId, seatId) {
  try {
    await api(`/api/admin/devices/${encodeURIComponent(deviceId)}/seat`, {
      method: 'POST', body: JSON.stringify({ seat_id: seatId }),
    });
    notify(seatId ? `Đã gán máy vào ${seatId}` : 'Đã bỏ gán chỗ ngồi');
    await fetchDevices();
    if ($('#seat-modal').open) $('#seat-modal').close();
  } catch (error) { notify(`Không cập nhật được chỗ ngồi: ${error.message}`); }
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
  const url = new URL('/boss-chat.html', window.location.origin);
  url.searchParams.set('device_id', device.id);
  url.searchParams.set('hostname', device.hostname || device.id);
  window.open(url, `chat-${device.id}`, 'popup,width=430,height=650');
}

async function acknowledgeAlert(id) {
  try {
    await api(`/api/admin/chat/alerts/${id}/acknowledge`, { method: 'POST' });
    state.alerts = state.alerts.filter((alert) => alert.id !== id);
    renderAlerts();
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
    [['Máy', device.hostname || 'Chưa đặt tên'], ['RustDesk ID', device.id], ['Chat key', isActive(device) ? (device.key_label || 'Đã cấp') : 'Chờ kích hoạt']].forEach(([label, value]) => {
      info.append(element('span', '', label), element('strong', label === 'RustDesk ID' ? 'mono' : '', value));
    });
    const actions = element('div', 'modal-actions');
    if (!isActive(device)) actions.append(actionButton('Kích hoạt chat', 'primary', () => activateDevice(device)));
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
  ['device-pending', 'device-activated', 'device-updated', 'device-key-revoked'].forEach((eventName) => {
    source.addEventListener(eventName, () => Promise.all([fetchDevices(), fetchKeys()]).catch(console.error));
  });
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
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/admin/session', { method: 'POST', body: JSON.stringify({ token: $('#admin-token').value }) });
    $('#admin-token').value = '';
    showDashboard();
    await fetchKeywords();
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
$('#search-input').addEventListener('input', renderDevices);
document.querySelectorAll('.tab-button').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));

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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !appView.hidden) refreshAll({ quiet: true });
});

(async function bootstrap() {
  try {
    await api('/api/admin/session');
    showDashboard();
    await fetchKeywords();
    const initialTab = ['devices', 'map', 'keys', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'devices';
    switchTab(initialTab);
  } catch (_error) { showLogin(); }
}());
