'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-chat-test-'));
process.env.DATABASE_PATH = path.join(tempDirectory, 'test.db');
process.env.ADMIN_TOKEN = 'integration-admin-token';
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
    ...json({ token: process.env.ADMIN_TOKEN }),
  });
  assert.equal(response.status, 200);
  adminCookie = response.headers.get('set-cookie').split(';')[0];

  response = await request('/api/device/save-password', {
    method: 'POST',
    ...json({ id: 'device-101', hostname: 'Seat client', pass: '', chat_token: 'device-token-101' }),
  });
  assert.equal(response.status, 202);
  const pendingRegistration = await response.json();
  assert.equal(pendingRegistration.activated, false);
  assert.equal(pendingRegistration.key_entry_required, false);

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
});
