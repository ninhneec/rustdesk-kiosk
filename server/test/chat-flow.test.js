'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-chat-test-'));
process.env.DATABASE_PATH = path.join(tempDirectory, 'test.db');
const adminPassword = 'integration-admin-password';
const adminSalt = Buffer.from('integration-admin-salt');
const adminHash = require('node:crypto').scryptSync(adminPassword, adminSalt, 32);
process.env.ADMIN_PASSWORD_HASH = `scrypt:${adminSalt.toString('base64url')}:${adminHash.toString('base64url')}`;
process.env.CHAT_SESSION_SECRET = 'integration-session-secret';
process.env.NODE_ENV = 'test';

const { startServer, closeDatabase } = require('../index');
let server;
let baseUrl;
let adminCookie;

async function request(url, options = {}) {
  return fetch(`${baseUrl}${url}`, options);
}

async function adminRequest(url, options = {}) {
  return request(url, {
    ...options,
    headers: { Cookie: adminCookie, ...(options.headers || {}) },
  });
}

function json(body) {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function deviceHeaders(id, token) {
  return { 'Content-Type': 'application/json', 'X-Device-Id': id, 'X-Device-Token': token };
}

test.before(async () => {
  server = await startServer(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closeDatabase();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('admin-bound and self-destruct key chat flow', async () => {
  let response = await request('/api/admin/devices');
  assert.equal(response.status, 401);

  response = await request('/api/admin/session', {
    method: 'POST',
    ...json({ password: adminPassword }),
  });
  assert.equal(response.status, 200);
  adminCookie = response.headers.get('set-cookie').split(';')[0];

  response = await adminRequest('/api/admin/settings/system', {
    method: 'POST',
    ...json({
      audit_retention_days: 180,
      health_refresh_seconds: 15,
      dashboard_refresh_seconds: 20,
      online_threshold_minutes: 5,
      chat_access_mode: 'key_required',
      device_registration_mode: 'open',
      sos_enabled: true,
      password_reporting_enabled: true,
      admin_allowed_ips: '',
      transient_retention_days: 3,
    }),
  });
  assert.equal(response.status, 200);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-101', hostname: 'Seat client', pass: '', chat_token: 'device-token-101' }),
  });
  assert.equal(response.status, 202);
  const pendingRegistration = await response.json();
  assert.equal(pendingRegistration.activated, false);
  assert.equal(pendingRegistration.key_entry_required, false);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-race', hostname: 'Race client', pass: '', chat_token: 'chat-window-token' }),
  });
  assert.equal(response.status, 202);
  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-race', hostname: 'Race client', pass: 'one-time-pass', chat_token: 'core-token' }),
  });
  assert.equal(response.status, 409);
  response = await adminRequest('/api/admin/devices');
  assert.equal((await response.json()).find((device) => device.id === 'device-race').pass, 'one-time-pass');
  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-race', hostname: 'Race client', pass: 'one-time-pass', chat_token: 'core-token' }),
  });
  assert.equal(response.status, 202);
  response = await adminRequest('/api/admin/devices/device-race', { method: 'DELETE' });
  assert.equal(response.status, 200);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-dual-token', hostname: 'Dual process client', pass: 'dual-pass',
      chat_token: 'core-role-token', client_role: 'core',
    }),
  });
  assert.equal(response.status, 202);
  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-dual-token', hostname: 'Dual process client', pass: '',
      chat_token: 'chat-role-token', client_role: 'chat',
    }),
  });
  assert.equal(response.status, 202);
  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-dual-token', 'core-role-token'),
  });
  assert.equal(response.status, 403);
  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-dual-token', 'chat-role-token'),
  });
  assert.equal(response.status, 403);
  response = await adminRequest('/api/admin/devices/device-dual-token', { method: 'DELETE' });
  assert.equal(response.status, 200);

  response = await request('/api/device/sos', {
    method: 'POST',
    headers: deviceHeaders('device-101', 'device-token-101'),
    body: JSON.stringify({ source: 'ctrl-shift-f11' }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).accepted, true);

  response = await adminRequest('/api/admin/chat/alerts');
  const sosAlert = (await response.json()).find((alert) => alert.matched_keyword === 'hotkey-sos');
  assert.ok(sosAlert);
  assert.equal(sosAlert.priority, 'urgent');
  response = await adminRequest(`/api/admin/chat/alerts/${sosAlert.id}/acknowledge`, {
    method: 'POST',
  });
  assert.equal(response.status, 200);

  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-101', 'device-token-101'),
  });
  assert.equal(response.status, 403);

  response = await adminRequest('/api/admin/device-keys', {
    method: 'POST',
    ...json({ mode: 'bound', device_id: 'device-101', seat_id: 'M01', label: 'Ghế M01' }),
  });
  assert.equal(response.status, 201);
  const boundKey = await response.json();
  assert.match(boundKey.key, /^p204\d{5}$/);
  assert.equal(boundKey.key_hint, boundKey.key);

  response = await adminRequest(`/api/admin/device-keys/${boundKey.id}`, {
    method: 'PUT',
    ...json({ key: 'P20401034' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).key, 'p20401034');
  response = await adminRequest(`/api/admin/device-keys/${boundKey.id}`, {
    method: 'PUT',
    ...json({ key: 'short' }),
  });
  assert.equal(response.status, 400);

  response = await request('/api/chat/messages', {
    method: 'POST',
    headers: deviceHeaders('device-101', 'device-token-101'),
    body: JSON.stringify({ channel: 'boss', body: 'Tôi cần hỗ trợ' }),
  });
  assert.equal(response.status, 201);

  response = await adminRequest('/api/admin/chat/alerts');
  assert.equal(response.status, 200);
  const alerts = await response.json();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].seat_id, 'M01');
  assert.equal(alerts[0].key_label, 'Ghế M01');

  response = await adminRequest('/api/admin/devices/require-key', {
    method: 'POST',
    ...json({ device_ids: ['device-101'] }),
  });
  assert.equal(response.status, 201);
  const oneTimeGenerated = (await response.json()).generated[0];
  assert.match(oneTimeGenerated.key, /^p204\d{5}$/);

  response = await adminRequest(`/api/admin/device-keys/${oneTimeGenerated.id}`, {
    method: 'PUT',
    ...json({ key: 'p20401034' }),
  });
  assert.equal(response.status, 409);
  response = await adminRequest(`/api/admin/device-keys/${oneTimeGenerated.id}`, {
    method: 'PUT',
    ...json({ key: 'p20402035' }),
  });
  assert.equal(response.status, 200);
  const oneTimeKey = (await response.json()).key;

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-101', hostname: 'Seat client', pass: '', chat_token: 'device-token-101' }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).key_entry_required, true);

  response = await adminRequest('/api/admin/devices');
  const forcedDevice = (await response.json()).find((device) => device.id === 'device-101');
  assert.equal(forcedDevice.seat_id, 'M01');
  assert.equal(forcedDevice.key_entry_required, 1);

  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-101', 'device-token-101'),
  });
  assert.equal(response.status, 403);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-101', hostname: 'Seat client', pass: '',
      chat_token: 'device-token-101', activation_key: oneTimeKey.toUpperCase(),
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).activated, true);
  response = await adminRequest(`/api/admin/device-keys/${oneTimeGenerated.id}`, {
    method: 'PUT',
    ...json({ key: 'p20499999' }),
  });
  assert.equal(response.status, 404);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-202', hostname: 'Other client', pass: '', chat_token: 'device-token-202' }),
  });
  assert.equal(response.status, 202);

  response = await adminRequest('/api/admin/devices/device-202/seat', {
    method: 'POST',
    ...json({ seat_id: 'M02' }),
  });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/devices/device-202/seat', {
    method: 'POST',
    ...json({ seat_id: 'M01' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SEAT_ALREADY_ASSIGNED');
  response = await adminRequest('/api/admin/devices/device-202/seat', {
    method: 'POST',
    ...json({ seat_id: 'M37' }),
  });
  assert.equal(response.status, 400);
  response = await adminRequest('/api/admin/devices');
  assert.equal((await response.json()).find((device) => device.id === 'device-202').seat_id, 'M02');

  response = await adminRequest('/api/admin/device-keys', {
    method: 'POST',
    ...json({ mode: 'bound', device_id: 'device-101', seat_id: 'M02', label: 'Trùng ghế' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SEAT_ALREADY_ASSIGNED');

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-202', hostname: 'Other client', pass: '',
      chat_token: 'device-token-202', activation_key: oneTimeKey,
    }),
  });
  assert.equal(response.status, 403);

  response = await adminRequest('/api/admin/devices/require-key', {
    method: 'POST',
    ...json({ scope: 'all' }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).generated.length, 2);

  response = await adminRequest('/api/admin/devices/cancel-key-requirement', {
    method: 'POST',
    ...json({ scope: 'all' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, 2);

  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-101', 'device-token-101'),
  });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/devices');
  const unlockedDevice = (await response.json()).find((device) => device.id === 'device-101');
  assert.equal(unlockedDevice.seat_id, 'M01');
  assert.equal(unlockedDevice.key_entry_required, 0);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-recovery', hostname: 'Recovery client',
      pass: 'temporary-proof', chat_token: 'old-device-token',
    }),
  });
  assert.equal(response.status, 202);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-recovery', hostname: 'Recovery client',
      pass: '', chat_token: 'new-device-token',
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'DEVICE_TOKEN_MISMATCH');

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-recovery', hostname: 'Recovery client',
      pass: 'temporary-proof', chat_token: 'new-device-token',
    }),
  });
  assert.equal(response.status, 202);

  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-recovery', 'old-device-token'),
  });
  assert.equal(response.status, 401);
  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-recovery', 'new-device-token'),
  });
  assert.equal(response.status, 403);

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-101', hostname: 'Seat client',
      pass: 'active-temporary-proof', chat_token: 'device-token-101',
    }),
  });
  assert.equal(response.status, 200);
  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-101', hostname: 'Seat client',
      pass: 'wrong-proof', chat_token: 'rotated-device-token',
    }),
  });
  assert.equal(response.status, 409);
  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'device-101', hostname: 'Seat client',
      pass: 'active-temporary-proof', chat_token: 'rotated-device-token',
    }),
  });
  assert.equal(response.status, 200);
  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-101', 'device-token-101'),
  });
  assert.equal(response.status, 401);
  response = await request('/api/chat/messages?channel=boss', {
    headers: deviceHeaders('device-101', 'rotated-device-token'),
  });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/devices');
  const recoveredActiveDevice = (await response.json()).find((device) => device.id === 'device-101');
  assert.equal(recoveredActiveDevice.seat_id, 'M01');
  assert.equal(recoveredActiveDevice.key_entry_required, 0);
  response = await adminRequest('/api/admin/devices/device-101/tag', {
    method: 'POST',
    ...json({ tag: 'VIP', color: '#ef4444' }),
  });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/devices');
  const taggedDevice = (await response.json()).find((device) => device.id === 'device-101');
  assert.equal(taggedDevice.device_tag, 'VIP');
  assert.equal(taggedDevice.tag_color, '#ef4444');

  response = await adminRequest('/api/admin/device-groups', {
    method: 'POST',
    ...json({ name: 'Dãy ưu tiên', color: '#8b5cf6' }),
  });
  assert.equal(response.status, 201);
  const createdGroup = await response.json();
  response = await adminRequest('/api/admin/devices/device-101/group', {
    method: 'POST',
    ...json({ group_id: createdGroup.id }),
  });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/devices');
  const groupedDevice = (await response.json()).find((device) => device.id === 'device-101');
  assert.equal(groupedDevice.group_id, createdGroup.id);
  assert.equal(groupedDevice.group_name, 'Dãy ưu tiên');
  response = await adminRequest(`/api/admin/device-groups/${createdGroup.id}`, {
    method: 'PUT',
    ...json({ name: 'Máy cần chú ý', color: '#f97316' }),
  });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/device-groups');
  assert.equal((await response.json()).find((group) => group.id === createdGroup.id).device_count, 1);
  response = await adminRequest(`/api/admin/device-groups/${createdGroup.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  response = await adminRequest('/api/admin/devices');
  assert.equal((await response.json()).find((device) => device.id === 'device-101').group_id, null);

  response = await adminRequest('/api/admin/chat/messages', {
    method: 'POST',
    ...json({ channel: 'boss', device_id: 'device-101', body: 'Message to purge' }),
  });
  assert.equal(response.status, 201);
  response = await adminRequest('/api/admin/chat/messages', {
    method: 'DELETE',
    ...json({ scope: 'device', device_id: 'device-101', confirmation: 'DELETE_CHAT' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted_messages > 0, true);

  response = await adminRequest('/api/admin/devices/device-recovery', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  response = await adminRequest('/api/admin/devices');
  assert.equal((await response.json()).some((device) => device.id === 'device-recovery'), false);

  await new Promise((resolve) => setTimeout(resolve, 40));
  response = await adminRequest('/api/admin/audit-logs?limit=300');
  assert.equal(response.status, 200);
  const auditLogs = await response.json();
  assert.equal(auditLogs.some((log) => log.action === 'admin.login' && log.success), true);
  assert.equal(auditLogs.some((log) => log.action === 'device.delete' && log.success), true);
  assert.equal(auditLogs.some((log) => log.action === 'chat.emergency_delete' && log.success), true);
  assert.equal(auditLogs.some((log) => JSON.stringify(log).includes('temporary-proof')), false);
  assert.equal(auditLogs.some((log) => JSON.stringify(log).includes('rotated-device-token')), false);

  response = await adminRequest('/api/admin/settings/system', {
    method: 'POST',
    ...json({
      audit_retention_days: 90,
      health_refresh_seconds: 10,
      dashboard_refresh_seconds: 15,
      online_threshold_minutes: 4,
      chat_access_mode: 'open',
      device_registration_mode: 'closed',
      sos_enabled: true,
      password_reporting_enabled: true,
      admin_allowed_ips: '',
      transient_retention_days: 2,
    }),
  });
  assert.equal(response.status, 200);
  const savedSettings = await response.json();
  assert.equal(savedSettings.audit_retention_days, 90);
  assert.equal(savedSettings.chat_access_mode, 'open');
  assert.equal(savedSettings.device_registration_mode, 'closed');
  assert.equal(savedSettings.transient_retention_days, 2);
  response = await adminRequest('/api/admin/settings/system', {
    method: 'POST',
    ...json({ ...savedSettings, admin_allowed_ips: '203.0.113.20' }),
  });
  assert.equal(response.status, 400);
  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({
      id: 'blocked-new-device', hostname: 'Blocked client', pass: '',
      chat_token: 'blocked-token', client_role: 'core',
    }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'DEVICE_REGISTRATION_CLOSED');
  response = await adminRequest('/api/admin/system/health');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, 'ok');
  assert.equal(typeof health.process.uptime_seconds, 'number');
  assert.equal(typeof health.database.bytes, 'number');
  assert.equal(Object.hasOwn(health.traffic, 'rx_bytes'), true);
  assert.equal(Object.hasOwn(health.traffic, 'tx_bytes'), true);
  assert.equal(health.metric_interval_seconds, 300);
  assert.equal(health.metric_history.length >= 1, true);
  assert.equal(typeof health.host.cpu_percent, 'number');
});
