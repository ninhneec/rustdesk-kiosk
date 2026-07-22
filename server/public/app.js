'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { devices: [], alerts: [], keys: [], eventSource: null, refreshTimer: null };
const loginView = $('#login-view');
const appView = $('#app');
const toast = $('#toast');
let toastTimer;
const mapView = {
  scale: 1,
  x: 0,
  y: 0,
  minScale: 0.55,
  maxScale: 2.2,
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
    cell.colSpan = 9;
    row.append(cell);
    body.append(row);
    return;
  }

  devices.forEach((device) => {
    const active = isActive(device);
    const online = isOnline(device);
    const forcedKey = Number(device.key_entry_required) === 1;
    const row = element('tr');
    const connectionCell = element('td');
    connectionCell.append(element('span', `status ${online ? 'online' : 'offline'}`, online ? 'Online' : 'Offline'));

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
    if (forcedKey) actions.append(actionButton('Gỡ ép key', 'ghost', () => cancelKeyRequirement([device.id])));
    if (!active && !forcedKey) actions.append(actionButton('Kích hoạt', 'primary', () => activateDevice(device)));
    if (active) {
      actions.append(actionButton('Nhập key lại', 'danger', () => requireNewKeys([device.id])));
      actions.append(actionButton('Chat', 'ghost', () => openBossChat(device)));
    }
    const connect = element('a', 'button compact ghost', 'Kết nối');
    connect.href = `rustdesk://connect?id=${encodeURIComponent(device.id)}`;
    actions.append(connect);
    actionsCell.append(actions);
    row.append(connectionCell, accessCell, machineCell, idCell, passwordCell, seatCell, keyCell, lastCell, actionsCell);
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
      const status = !device ? '' : !isActive(device) ? 'pending assigned' : isOnline(device) ? 'online assigned' : 'offline assigned';
      const desk = element('button', `desk ${index % 2 === 0 ? 'upper' : 'lower'} ${status}`.trim());
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
      desk.addEventListener('click', () => {
        grid.querySelector('.desk.selected')?.classList.remove('selected');
        desk.classList.add('selected');
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
  grid.style.transform = `translate3d(${mapView.x}px, ${mapView.y}px, 0) scale(${mapView.scale})`;
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
    zoomMap(mapView.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
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
  if (tab === 'map') requestAnimationFrame(() => mapView.initialized ? applyMapView() : fitMapView());
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
$('#cancel-all-keys-btn').addEventListener('click', () => cancelKeyRequirement());
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

setupMapInteractions();

(async function bootstrap() {
  try {
    await api('/api/admin/session');
    showDashboard();
    await fetchKeywords();
    const initialTab = ['devices', 'map', 'keys', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'devices';
    switchTab(initialTab);
  } catch (_error) { showLogin(); }
}());
