const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = Number(process.env.PORT || 3000);
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
const sessionSecret = process.env.CHAT_SESSION_SECRET || '';
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'devices.db');
const isProduction = process.env.NODE_ENV === 'production';
const sessionCookieName = 'kiosk_admin_session';
const sessionDurationSeconds = 12 * 60 * 60;
const defaultKeywords = 'khẩn cấp,cứu,nguy hiểm,help,sos';
const db = new sqlite3.Database(databasePath);
const adminStreams = new Set();
const rateBuckets = new Map();
let alertKeywords = parseKeywords(process.env.ALERT_KEYWORDS || defaultKeywords);
let databaseReady;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use((req, _res, next) => {
  if (!req.body) req.body = {};
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: isProduction ? '1h' : 0,
  setHeaders: (res, filePath) => {
    if (/\.(?:html|css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.use(async (_req, res, next) => {
  try {
    await databaseReady;
    next();
  } catch (error) {
    console.error('Database initialization failed:', error);
    fail(res, 503, 'Database unavailable');
  }
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

async function settingValue(key, fallback) {
  const row = await dbGet('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value || fallback;
}

async function cleanupTransientData() {
  const configured = Number(await settingValue('transient_retention_days', '3'));
  const retentionDays = configured === 2 ? 2 : 3;
  const cutoff = `-${retentionDays} days`;
  await dbRun("DELETE FROM system_metrics WHERE created_at < datetime('now', ?)", [cutoff]);
  await dbRun("DELETE FROM chat_alerts WHERE acknowledged = 1 AND created_at < datetime('now', ?)", [cutoff]);
}

function linuxNetworkTotals() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    return lines.reduce((total, line) => {
      const [namePart, countersPart] = line.trim().split(':');
      if (!countersPart || namePart.trim() === 'lo') return total;
      const counters = countersPart.trim().split(/\s+/).map(Number);
      total.rx_bytes += counters[0] || 0;
      total.tx_bytes += counters[8] || 0;
      return total;
    }, { rx_bytes: 0, tx_bytes: 0 });
  } catch (_error) {
    return { rx_bytes: null, tx_bytes: null };
  }
}

let previousCpuTimes = null;
function cpuUsagePercent() {
  const current = os.cpus().reduce((total, cpu) => {
    const values = Object.values(cpu.times);
    total.total += values.reduce((sum, value) => sum + value, 0);
    total.idle += cpu.times.idle;
    return total;
  }, { idle: 0, total: 0 });
  if (!previousCpuTimes) {
    previousCpuTimes = current;
    return Math.max(0, Math.min(100, (os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100));
  }
  const totalDelta = current.total - previousCpuTimes.total;
  const idleDelta = current.idle - previousCpuTimes.idle;
  previousCpuTimes = current;
  return totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
}

async function addColumnIfMissing(table, column, definition) {
  const columns = await dbAll(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initializeDatabase() {
  await dbRun('PRAGMA journal_mode = WAL');
  await dbRun('PRAGMA synchronous = NORMAL');
  await dbRun('PRAGMA busy_timeout = 5000');
  await dbRun('PRAGMA foreign_keys = ON');

  await dbRun(`CREATE TABLE IF NOT EXISTS device_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    key_hint TEXT NOT NULL,
    label TEXT NOT NULL,
    seat_id TEXT,
    device_id TEXT,
    mode TEXT NOT NULL DEFAULT 'bound',
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    consumed_at DATETIME
  )`);
  await addColumnIfMissing('device_keys', 'mode', "TEXT NOT NULL DEFAULT 'bound'");
  await addColumnIfMissing('device_keys', 'consumed_at', 'DATETIME');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_device_keys_device ON device_keys(device_id, active)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_device_keys_seat ON device_keys(seat_id, active)');

  await dbRun(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    pass TEXT,
    hostname TEXT,
    chat_token TEXT,
    seat_id TEXT,
    access_key_id INTEGER,
    key_entry_required INTEGER NOT NULL DEFAULT 0,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(access_key_id) REFERENCES device_keys(id)
  )`);
  await addColumnIfMissing('devices', 'chat_token', 'TEXT');
  await addColumnIfMissing('devices', 'core_token', 'TEXT');
  await addColumnIfMissing('devices', 'ui_token', 'TEXT');
  await addColumnIfMissing('devices', 'seat_id', 'TEXT');
  await addColumnIfMissing('devices', 'access_key_id', 'INTEGER');
  await addColumnIfMissing('devices', 'key_entry_required', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('devices', 'device_tag', 'TEXT');
  await addColumnIfMissing('devices', 'tag_color', 'TEXT');
  await addColumnIfMissing('devices', 'group_id', 'INTEGER');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_devices_seat ON devices(seat_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_devices_group ON devices(group_id)');

  await dbRun(`CREATE TABLE IF NOT EXISTS device_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#4ed8c3',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL CHECK(channel IN ('boss', 'global')),
    sender_id TEXT NOT NULL,
    recipient_id TEXT,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_id ON chat_messages(channel, id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient_id ON chat_messages(recipient_id, id)');

  await dbRun(`CREATE TABLE IF NOT EXISTS chat_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    matched_keyword TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    seat_id TEXT,
    key_id INTEGER,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES chat_messages(id),
    FOREIGN KEY(key_id) REFERENCES device_keys(id)
  )`);
  await addColumnIfMissing('chat_alerts', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  await addColumnIfMissing('chat_alerts', 'seat_id', 'TEXT');
  await addColumnIfMissing('chat_alerts', 'key_id', 'INTEGER');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_chat_alerts_active ON chat_alerts(acknowledged, id DESC)');

  await dbRun(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    details TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(id DESC)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, id DESC)');
  await dbRun("DELETE FROM audit_logs WHERE created_at < datetime('now', '-180 days')");

  await dbRun(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS system_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpu_percent REAL NOT NULL,
    ram_percent REAL NOT NULL,
    disk_percent REAL NOT NULL,
    rx_bytes INTEGER,
    tx_bytes INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_system_metrics_created ON system_metrics(id DESC)');
  await dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('transient_retention_days', '3')");
  await cleanupTransientData();
  const keywordSetting = await dbGet('SELECT value FROM settings WHERE key = ?', ['alert_keywords']);
  if (keywordSetting?.value) {
    alertKeywords = parseKeywords(keywordSetting.value);
  } else {
    const initialKeywords = process.env.ALERT_KEYWORDS || defaultKeywords;
    await dbRun('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', ['alert_keywords', initialKeywords]);
    alertKeywords = parseKeywords(initialKeywords);
  }
}

databaseReady = initializeDatabase();
databaseReady.then(() => {
  const cleanupTimer = setInterval(() => cleanupTransientData().catch((error) => {
    console.error('Could not clean transient data:', error);
  }), 24 * 60 * 60_000);
  cleanupTimer.unref();
});

function auditAction(method, routePath) {
  const route = `${method} ${routePath}`;
  const rules = [
    [/POST \/api\/admin\/session$/, 'admin.login'],
    [/DELETE \/api\/admin\/session$/, 'admin.logout'],
    [/POST \/api\/device\/save-password$/, 'device.register_or_heartbeat'],
    [/POST \/api\/device\/sos$/, 'device.sos'],
    [/POST \/api\/admin\/devices\/[^/]+\/seat$/, 'device.assign_seat'],
    [/POST \/api\/admin\/devices\/[^/]+\/tag$/, 'device.update_tag'],
    [/POST \/api\/admin\/devices\/[^/]+\/group$/, 'device.assign_group'],
    [/DELETE \/api\/admin\/devices\/[^/]+$/, 'device.delete'],
    [/POST \/api\/admin\/device-groups$/, 'group.create'],
    [/PUT \/api\/admin\/device-groups\/[^/]+$/, 'group.update'],
    [/DELETE \/api\/admin\/device-groups\/[^/]+$/, 'group.delete'],
    [/POST \/api\/admin\/devices\/require-key$/, 'device.require_key'],
    [/POST \/api\/admin\/devices\/cancel-key-requirement$/, 'device.cancel_key_requirement'],
    [/POST \/api\/admin\/device-keys$/, 'key.create'],
    [/PUT \/api\/admin\/device-keys\/[^/]+$/, 'key.update'],
    [/POST \/api\/admin\/device-keys\/[^/]+\/revoke$/, 'key.revoke'],
    [/POST \/api\/chat\/messages$/, 'chat.device_message'],
    [/POST \/api\/admin\/chat\/messages$/, 'chat.admin_message'],
    [/DELETE \/api\/admin\/chat\/messages$/, 'chat.emergency_delete'],
    [/POST \/api\/admin\/chat\/alerts\/[^/]+\/acknowledge$/, 'alert.acknowledge'],
    [/POST \/api\/admin\/settings\/keywords$/, 'settings.update_keywords'],
    [/POST \/api\/admin\/settings\/system$/, 'settings.update_system'],
  ];
  return rules.find(([pattern]) => pattern.test(route))?.[1] || 'api.mutation';
}

function auditRequest(req, status) {
  const routePath = req.route?.path
    ? `${req.baseUrl || ''}${req.route.path}`.replace(/:([A-Za-z_]+)/g, (_match, name) => req.params?.[name] || `:${name}`)
    : req.path;
  const action = auditAction(req.method, routePath);
  // Successful device heartbeats are high-frequency state refreshes, not audit
  // events. Keep new registrations (202) and every failed attempt.
  if (action === 'device.register_or_heartbeat' && status === 200) return;
  const body = req.body || {};
  const deviceIds = Array.isArray(body.device_ids) ? body.device_ids.slice(0, 50) : undefined;
  const entityId = req.params?.id || body.device_id || body.id || (deviceIds?.length === 1 ? deviceIds[0] : null);
  const actorType = req.deviceId ? 'device' : req.path.startsWith('/api/admin') ? 'admin' : 'device';
  const actorId = req.deviceId || (actorType === 'device' ? body.id : 'admin');
  const details = {
    method: req.method,
    path: routePath,
    status,
    channel: body.channel,
    mode: body.mode,
    seat_id: body.seat_id,
    scope: body.scope,
    device_ids: deviceIds,
    message_length: typeof body.body === 'string' ? body.body.length : undefined,
  };
  Object.keys(details).forEach((key) => details[key] === undefined && delete details[key]);
  databaseReady
    .then(() => dbRun(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, success, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actorType,
        actorId || null,
        action,
        entityId ? (routePath.includes('device-key') ? 'key' : routePath.includes('alert') ? 'alert' : 'device') : null,
        entityId ? String(entityId) : null,
        status < 400 ? 1 : 0,
        JSON.stringify(details),
      ],
    ))
    .then(() => emitAdminEvent('audit-created', { action }))
    .catch((error) => console.error('Could not write audit log:', error));
}

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/')) return next();
  res.on('finish', () => auditRequest(req, res.statusCode));
  next();
});

function parseKeywords(value) {
  return [...new Set(
    (value || '')
      .split(',')
      .map((keyword) => keyword.trim().normalize('NFC').toLocaleLowerCase('vi'))
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length);
}

function fail(res, status, error, code) {
  return res.status(status).json({ error, code: code || undefined });
}

function text(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength
    ? value.trim()
    : null;
}

function deviceId(value) {
  const id = text(value, 128);
  return id && /^[A-Za-z0-9._-]+$/.test(id) ? id : null;
}

function seatId(value) {
  const seat = text(value, 24);
  const normalized = seat?.toUpperCase();
  return normalized && /^M(?:0[1-9]|[12]\d|3[0-6])$/.test(normalized) ? normalized : null;
}

function token(value) {
  const valueAsText = text(value, 256);
  return valueAsText && /^[A-Za-z0-9_-]+$/.test(valueAsText) ? valueAsText : null;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyAdminPassword(password) {
  const parts = adminPasswordHash.includes(':') ? adminPasswordHash.split(':') : adminPasswordHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}

function hashDeviceKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function editableDeviceKey(value) {
  const rawKey = text(value, 16)?.toLowerCase();
  return rawKey && /^[a-z0-9]{8,16}$/.test(rawKey) ? rawKey : null;
}

async function generateShortDeviceKey() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const rawKey = `p204${crypto.randomInt(0, 100_000).toString().padStart(5, '0')}`;
    const existing = await dbGet('SELECT id FROM device_keys WHERE key_hash = ?', [hashDeviceKey(rawKey)]);
    if (!existing) return rawKey;
  }
  throw new Error('Could not allocate a unique short key');
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.get('cookie') || '')
      .split(';')
      .map((item) => item.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]),
  );
}

function signSession(expiresAt) {
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(value) {
  if (!sessionSecret || !value) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  if (!safeEqual(expected, signature)) return false;
  try {
    return Number(JSON.parse(Buffer.from(payload, 'base64url').toString()).expiresAt) > Date.now();
  } catch (_error) {
    return false;
  }
}

function clientIp(req) {
  return String(req.ip || '').replace(/^::ffff:/, '');
}

async function adminIpAllowed(req) {
  const configured = await settingValue('admin_allowed_ips', '');
  if (!configured.trim()) return true;
  const allowed = configured.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  return allowed.includes(clientIp(req));
}

async function requireAdmin(req, res, next) {
  if (!adminPasswordHash || !sessionSecret) return fail(res, 503, 'Admin access is not configured');
  if (!await adminIpAllowed(req)) return fail(res, 403, 'IP này không được phép truy cập web admin', 'ADMIN_IP_DENIED');
  if (!validSession(parseCookies(req)[sessionCookieName])) return fail(res, 401, 'Admin login required');
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return fail(res, 403, 'Invalid origin');
  } catch (_error) {
    return fail(res, 403, 'Invalid origin');
  }
  next();
}

function rateLimit(name, maxRequests, windowMs) {
  return (req, res, next) => {
    const identity = req.deviceId || req.ip || 'unknown';
    const bucketKey = `${name}:${identity}`;
    const now = Date.now();
    const bucket = rateBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return fail(res, 429, 'Too many requests');
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 60_000).unref();

async function authenticateDevice(req, res) {
  const id = deviceId(req.get('x-device-id'));
  const suppliedToken = token(req.get('x-device-token'));
  if (!id || !suppliedToken) {
    fail(res, 401, 'Missing device credentials');
    return null;
  }
  try {
    const row = await dbGet(
      `SELECT d.chat_token, d.core_token, d.ui_token, d.access_key_id, d.seat_id,
              d.key_entry_required, k.active AS key_active
         FROM devices d LEFT JOIN device_keys k ON k.id = d.access_key_id
        WHERE d.id = ?`,
      [id],
    );
    const validToken = row && [row.chat_token, row.core_token, row.ui_token]
      .some((candidate) => candidate && safeEqual(candidate, suppliedToken));
    if (!validToken) {
      fail(res, 401, 'Unauthorized');
      return null;
    }
    return { id, row };
  } catch (error) {
    console.error('Device authentication failed:', error);
    fail(res, 500, 'Database error');
    return null;
  }
}

async function requireRegisteredDevice(req, res, next) {
  const authenticated = await authenticateDevice(req, res);
  if (!authenticated) return;
  req.deviceId = authenticated.id;
  req.device = authenticated.row;
  next();
}

async function requireDevice(req, res, next) {
  const authenticated = await authenticateDevice(req, res);
  if (!authenticated) return;
  const { id, row } = authenticated;
  try {
    const chatAccessMode = await settingValue('chat_access_mode', 'open');
    if (chatAccessMode === 'key_required' && (!row.access_key_id || row.key_active !== 1)) {
      const mustEnterKey = Number(row.key_entry_required) === 1;
      return fail(
        res,
        403,
        mustEnterKey ? 'Quản trị viên yêu cầu nhập key mới' : 'Máy đang chờ quản trị viên kích hoạt chat',
        mustEnterKey ? 'KEY_ENTRY_REQUIRED' : 'ACTIVATION_PENDING',
      );
    }
    req.deviceId = id;
    req.device = row;
    next();
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
}

function matchedAlertKeyword(body) {
  const normalized = body.normalize('NFC').toLocaleLowerCase('vi');
  return alertKeywords.find((keyword) => {
    const start = normalized.indexOf(keyword);
    if (start < 0) return false;
    const before = normalized[start - 1] || '';
    const after = normalized[start + keyword.length] || '';
    const isWordCharacter = (character) => /[\p{L}\p{N}]/u.test(character);
    return !isWordCharacter(before) && !isWordCharacter(after);
  }) || '';
}

function emitAdminEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of adminStreams) stream.write(payload);
}

async function createChatAlert(messageId, senderId, body, channel, options = {}) {
  if (senderId === 'boss') return null;
  const keyword = options.matchedKeyword || matchedAlertKeyword(body);
  const priority = options.priority === 'urgent' || keyword ? 'urgent' : 'normal';
  const device = await dbGet(
    `SELECT d.hostname, d.seat_id, d.access_key_id, k.label AS key_label, k.key_hint
       FROM devices d LEFT JOIN device_keys k ON k.id = d.access_key_id
      WHERE d.id = ?`,
    [senderId],
  );
  const result = await dbRun(
    `INSERT OR IGNORE INTO chat_alerts
      (message_id, device_id, matched_keyword, priority, seat_id, key_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [messageId, senderId, keyword, priority, device?.seat_id || null, device?.access_key_id || null],
  );
  if (!result.changes) return null;
  const alert = {
    id: result.lastID,
    message_id: messageId,
    device_id: senderId,
    hostname: device?.hostname || senderId,
    seat_id: device?.seat_id || null,
    key_label: device?.key_label || null,
    key_hint: device?.key_hint || null,
    matched_keyword: keyword,
    priority,
    channel,
    body,
    created_at: new Date().toISOString(),
  };
  emitAdminEvent('chat-alert', alert);
  return alert;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/api/admin/session', rateLimit('admin-login', 8, 15 * 60_000), async (req, res) => {
  if (!await adminIpAllowed(req)) return fail(res, 403, 'IP này không được phép đăng nhập web admin', 'ADMIN_IP_DENIED');
  const suppliedPassword = text(req.body.password, 512) || '';
  if (!adminPasswordHash || !verifyAdminPassword(suppliedPassword)) return fail(res, 401, 'Sai mật khẩu quản trị');
  const expiresAt = Date.now() + sessionDurationSeconds * 1000;
  const cookie = [
    `${sessionCookieName}=${encodeURIComponent(signSession(expiresAt))}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${sessionDurationSeconds}`,
  ];
  if (req.secure) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
  res.json({ authenticated: true, expires_at: new Date(expiresAt).toISOString() });
});

app.get('/api/admin/session', requireAdmin, (_req, res) => {
  res.json({ authenticated: true });
});

app.delete('/api/admin/session', requireAdmin, requireSameOrigin, (_req, res) => {
  res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ authenticated: false });
});

app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  adminStreams.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    adminStreams.delete(res);
  });
});

app.post('/api/device/save-password', rateLimit('device-register', 30, 60_000), async (req, res) => {
  const id = deviceId(req.body.id);
  const pass = typeof req.body.pass === 'string' ? (text(req.body.pass, 512) || '') : '';
  const hostname = text(req.body.hostname, 255) || 'Unknown';
  const chatToken = token(req.body.chat_token);
  const clientRole = req.body.client_role === 'core'
    ? 'core'
    : req.body.client_role === 'chat' ? 'chat' : 'legacy';
  const activationKey = token(req.body.activation_key);
  if (!id || !chatToken) return fail(res, 400, 'Invalid device payload');

  try {
    const [chatAccessMode, registrationMode, passwordReporting] = await Promise.all([
      settingValue('chat_access_mode', 'open'),
      settingValue('device_registration_mode', 'open'),
      settingValue('password_reporting_enabled', '1'),
    ]);
    const existing = await dbGet(
      `SELECT d.pass, d.chat_token, d.core_token, d.ui_token, d.access_key_id,
              d.seat_id, d.key_entry_required, k.active AS key_active
         FROM devices d LEFT JOIN device_keys k ON k.id = d.access_key_id
        WHERE d.id = ?`,
      [id],
    );
    if (!existing && registrationMode === 'closed') {
      return fail(res, 403, 'Quản trị viên đang khóa đăng ký thiết bị mới', 'DEVICE_REGISTRATION_CLOSED');
    }
    const reportedPass = passwordReporting === '1' ? pass : '';
    const roleColumn = clientRole === 'core' ? 'core_token' : clientRole === 'chat' ? 'ui_token' : 'chat_token';
    let credentialsMatch = existing && [existing.chat_token, existing.core_token, existing.ui_token]
      .some((candidate) => candidate && safeEqual(candidate, chatToken));
    // Core and chat are independent RustDesk processes and may start together.
    // Give each role one immutable token slot instead of letting them overwrite
    // one shared token. Existing installations retain the legacy token.
    if (existing && clientRole !== 'legacy' && !existing[roleColumn]) {
      await dbRun(
        `UPDATE devices SET ${roleColumn} = ?, hostname = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
        [chatToken, hostname, id],
      );
      existing[roleColumn] = chatToken;
      credentialsMatch = true;
    }
    let passwordProofMatches = existing && reportedPass && safeEqual(existing.pass || '', reportedPass);
    // The independent chat window may register a new machine a few milliseconds
    // before the RustDesk core sends its temporary password. Accept that first
    // password without rotating the token. A later heartbeat can then prove the
    // same password and safely recover a token that lost the startup race.
    if (existing && !existing.pass && reportedPass) {
      await dbRun(
        `UPDATE devices SET pass = ?, hostname = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
        [reportedPass, hostname, id],
      );
      existing.pass = reportedPass;
      passwordProofMatches = credentialsMatch;
    }
    if (!credentialsMatch && passwordProofMatches) {
      await dbRun(
        `UPDATE devices SET chat_token = ?, hostname = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
        [chatToken, hostname, id],
      );
      existing.chat_token = chatToken;
    }
    if (credentialsMatch || passwordProofMatches) {
      await dbRun(
        `UPDATE devices SET pass = CASE WHEN ? = '' THEN pass ELSE ? END,
          hostname = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
        [reportedPass, reportedPass, hostname, id],
      );
      const activated = chatAccessMode === 'open'
        || Boolean(existing.access_key_id && existing.key_active === 1);
      if (activated || !activationKey) {
        return res.status(activated ? 200 : 202).json({
          result: activated ? 'OK' : 'PENDING',
          activated,
          seat_id: existing.seat_id || null,
          key_entry_required: Number(existing.key_entry_required) === 1,
        });
      }
    }

    if (existing && !credentialsMatch) return fail(res, 409, 'Thông tin xác thực của máy không khớp', 'DEVICE_TOKEN_MISMATCH');

    // New clients register themselves as pending. The administrator generates and
    // binds the key from the web dashboard, so nobody at the seat has to enter it.
    if (!activationKey) {
      await dbRun(
        `INSERT INTO devices
          (id, pass, hostname, chat_token, core_token, ui_token, key_entry_required, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
        [
          id, reportedPass, hostname, chatToken,
          clientRole === 'core' ? chatToken : null,
          clientRole === 'chat' ? chatToken : null,
        ],
      );
      emitAdminEvent('device-pending', { device_id: id, hostname });
      const activated = chatAccessMode === 'open';
      return res.status(activated ? 200 : 202).json({
        result: activated ? 'OK' : 'PENDING',
        activated,
        key_entry_required: false,
      });
    }

    // Retain server-side activation support for automated provisioning tools.
    const activationKeyHashes = [hashDeviceKey(activationKey)];
    const normalizedActivationKey = editableDeviceKey(activationKey);
    if (normalizedActivationKey && normalizedActivationKey !== activationKey) {
      activationKeyHashes.push(hashDeviceKey(normalizedActivationKey));
    }
    const keyRow = await dbGet(
      `SELECT * FROM device_keys
        WHERE key_hash IN (${activationKeyHashes.map(() => '?').join(',')})
          AND active = 1 AND consumed_at IS NULL`,
      activationKeyHashes,
    );
    if (!keyRow) return fail(res, 403, 'Key kích hoạt không hợp lệ hoặc đã bị thu hồi', 'INVALID_ACTIVATION_KEY');
    if (keyRow.device_id && keyRow.device_id !== id) {
      return fail(res, 409, 'Key đã được gắn với một máy khác', 'KEY_ALREADY_BOUND');
    }

    await dbRun('BEGIN IMMEDIATE');
    try {
      if (keyRow.seat_id) {
        const occupied = await dbGet(
          'SELECT id, hostname FROM devices WHERE seat_id = ? AND id <> ?',
          [keyRow.seat_id, id],
        );
        if (occupied) {
          await dbRun('ROLLBACK');
          return fail(res, 409, `${keyRow.seat_id} đã được gán cho ${occupied.hostname || occupied.id}`, 'SEAT_ALREADY_ASSIGNED');
        }
      }
      await dbRun(
        `INSERT INTO devices
          (id, pass, hostname, chat_token, core_token, ui_token, seat_id, access_key_id, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           pass = CASE WHEN excluded.pass = '' THEN devices.pass ELSE excluded.pass END,
           hostname = excluded.hostname,
           chat_token = excluded.chat_token,
           seat_id = COALESCE(excluded.seat_id, devices.seat_id),
           access_key_id = excluded.access_key_id,
           key_entry_required = 0,
           last_seen = CURRENT_TIMESTAMP`,
        [
          id, reportedPass, hostname, chatToken,
          clientRole === 'core' ? chatToken : null,
          clientRole === 'chat' ? chatToken : null,
          keyRow.seat_id || null, keyRow.id,
        ],
      );
      await dbRun(
        `UPDATE device_keys SET device_id = ?, last_used_at = CURRENT_TIMESTAMP,
          consumed_at = CASE WHEN mode = 'one_time' THEN CURRENT_TIMESTAMP ELSE consumed_at END,
          key_hint = CASE WHEN mode = 'one_time' THEN 'Đã sử dụng' ELSE key_hint END,
          key_hash = CASE WHEN mode = 'one_time' THEN ? ELSE key_hash END
         WHERE id = ?`,
        [id, hashDeviceKey(crypto.randomBytes(32).toString('hex')), keyRow.id],
      );
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    emitAdminEvent('device-activated', { device_id: id, hostname, seat_id: keyRow.seat_id, key_label: keyRow.label });
    res.json({ result: 'OK', activated: true, seat_id: keyRow.seat_id || null, label: keyRow.label });
  } catch (error) {
    console.error(`Could not register device ${id}:`, error);
    fail(res, 500, 'Database error');
  }
});

app.get('/api/admin/devices', requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT d.id, d.pass, d.hostname, d.seat_id, d.last_seen, d.access_key_id,
              d.key_entry_required, d.device_tag, d.tag_color, d.group_id,
              g.name AS group_name, g.color AS group_color,
              k.label AS key_label, k.key_hint, k.active AS key_active
         FROM devices d
         LEFT JOIN device_keys k ON k.id = d.access_key_id
         LEFT JOIN device_groups g ON g.id = d.group_id
        ORDER BY CASE WHEN d.seat_id IS NULL OR d.seat_id = '' THEN 1 ELSE 0 END,
                 d.seat_id COLLATE NOCASE, d.hostname COLLATE NOCASE, d.id`,
    );
    res.json(rows);
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.get('/api/admin/device-groups', requireAdmin, async (_req, res) => {
  try {
    res.json(await dbAll(
      `SELECT g.id, g.name, g.color, g.sort_order,
              COUNT(d.id) AS device_count
         FROM device_groups g LEFT JOIN devices d ON d.group_id = g.id
        GROUP BY g.id
        ORDER BY g.sort_order, g.name COLLATE NOCASE`,
    ));
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/device-groups', requireAdmin, requireSameOrigin, async (req, res) => {
  const name = text(req.body.name, 40);
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color.toLowerCase() : '#4ed8c3';
  if (!name) return fail(res, 400, 'Tên nhóm không hợp lệ');
  try {
    const result = await dbRun('INSERT INTO device_groups (name, color) VALUES (?, ?)', [name, color]);
    emitAdminEvent('device-group-updated', { group_id: result.lastID });
    res.status(201).json({ id: result.lastID, name, color });
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT') return fail(res, 409, 'Tên nhóm đã tồn tại');
    fail(res, 500, 'Database error');
  }
});

app.put('/api/admin/device-groups/:id', requireAdmin, requireSameOrigin, async (req, res) => {
  const groupId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  const name = text(req.body.name, 40);
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color.toLowerCase() : null;
  if (!groupId || !name || !color) return fail(res, 400, 'Dữ liệu nhóm không hợp lệ');
  try {
    const result = await dbRun('UPDATE device_groups SET name = ?, color = ? WHERE id = ?', [name, color, groupId]);
    if (!result.changes) return fail(res, 404, 'Group not found');
    emitAdminEvent('device-group-updated', { group_id: groupId });
    res.json({ id: groupId, name, color });
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT') return fail(res, 409, 'Tên nhóm đã tồn tại');
    fail(res, 500, 'Database error');
  }
});

app.delete('/api/admin/device-groups/:id', requireAdmin, requireSameOrigin, async (req, res) => {
  const groupId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  if (!groupId) return fail(res, 400, 'Invalid group id');
  try {
    await dbRun('UPDATE devices SET group_id = NULL WHERE group_id = ?', [groupId]);
    const result = await dbRun('DELETE FROM device_groups WHERE id = ?', [groupId]);
    if (!result.changes) return fail(res, 404, 'Group not found');
    emitAdminEvent('device-group-updated', { group_id: groupId, deleted: true });
    res.json({ deleted: true });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/devices/:id/group', requireAdmin, requireSameOrigin, async (req, res) => {
  const id = deviceId(req.params.id);
  const groupId = req.body.group_id === null || req.body.group_id === '' ? null : Number.parseInt(req.body.group_id, 10);
  if (!id || (groupId !== null && (!Number.isInteger(groupId) || groupId <= 0))) return fail(res, 400, 'Invalid group assignment');
  try {
    if (groupId !== null && !await dbGet('SELECT id FROM device_groups WHERE id = ?', [groupId])) {
      return fail(res, 404, 'Group not found');
    }
    const result = await dbRun('UPDATE devices SET group_id = ? WHERE id = ?', [groupId, id]);
    if (!result.changes) return fail(res, 404, 'Device not found');
    emitAdminEvent('device-updated', { device_id: id, group_id: groupId });
    res.json({ device_id: id, group_id: groupId });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/devices/:id/tag', requireAdmin, requireSameOrigin, async (req, res) => {
  const id = deviceId(req.params.id);
  const tag = text(req.body.tag, 24) || '';
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color.toLowerCase() : '#4ed8c3';
  if (!id) return fail(res, 400, 'Invalid device ID');
  try {
    const result = await dbRun(
      'UPDATE devices SET device_tag = ?, tag_color = ? WHERE id = ?',
      [tag, color, id],
    );
    if (!result.changes) return fail(res, 404, 'Device not found');
    emitAdminEvent('device-updated', { device_id: id, tag, tag_color: color });
    res.json({ device_id: id, tag, tag_color: color });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.delete('/api/admin/devices/:id', requireAdmin, requireSameOrigin, async (req, res) => {
  const id = deviceId(req.params.id);
  if (!id) return fail(res, 400, 'Thiết bị không hợp lệ');
  try {
    const existing = await dbGet('SELECT id, hostname, seat_id FROM devices WHERE id = ?', [id]);
    if (!existing) return fail(res, 404, 'Không tìm thấy thiết bị');
    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun('UPDATE device_keys SET active = 0, device_id = NULL WHERE device_id = ?', [id]);
      await dbRun('DELETE FROM devices WHERE id = ?', [id]);
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    emitAdminEvent('device-deleted', { device_id: id, hostname: existing.hostname, seat_id: existing.seat_id });
    res.json({ deleted: true, device_id: id });
  } catch (error) {
    console.error('Could not delete device:', error);
    fail(res, 500, 'Không thể xóa thiết bị');
  }
});

app.get('/api/admin/audit-logs', requireAdmin, async (req, res) => {
  const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 200));
  const action = text(req.query.action, 80);
  const query = text(req.query.query, 128);
  try {
    const where = [];
    const params = [];
    if (action && action !== 'all') {
      where.push('action = ?');
      params.push(action);
    }
    if (query) {
      where.push('(actor_id LIKE ? OR entity_id LIKE ? OR action LIKE ? OR details LIKE ?)');
      const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    params.push(limit);
    const rows = await dbAll(
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id, success, details, created_at
         FROM audit_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT ?`,
      params,
    );
    res.json(rows.map((row) => ({
      ...row,
      success: Boolean(row.success),
      details: (() => {
        try { return JSON.parse(row.details || '{}'); } catch (_error) { return {}; }
      })(),
    })));
  } catch (error) {
    console.error('Could not load audit logs:', error);
    fail(res, 500, 'Không thể tải nhật ký');
  }
});

app.get('/api/admin/system/health', requireAdmin, async (_req, res) => {
  try {
    const [deviceStats, chatStats, auditStats, lastBackup, recentFailures] = await Promise.all([
      dbGet(`SELECT COUNT(*) AS total,
                    SUM(CASE WHEN last_seen >= datetime('now', '-5 minutes') THEN 1 ELSE 0 END) AS online,
                    SUM(CASE WHEN access_key_id IS NOT NULL THEN 1 ELSE 0 END) AS activated
               FROM devices`),
      dbGet(`SELECT COUNT(*) AS messages,
                    (SELECT COUNT(*) FROM chat_alerts WHERE acknowledged = 0) AS open_alerts
               FROM chat_messages`),
      dbGet('SELECT COUNT(*) AS total FROM audit_logs'),
      dbGet("SELECT action, created_at FROM audit_logs WHERE action IN ('backup.success', 'backup.failed') ORDER BY id DESC LIMIT 1"),
      dbAll(`SELECT action, actor_id, entity_id, details, created_at
               FROM audit_logs WHERE success = 0 ORDER BY id DESC LIMIT 8`),
    ]);
    const processMemory = process.memoryUsage();
    const disk = fs.statfsSync(path.parse(databasePath).root || '/');
    const databaseBytes = fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0;
    const walPath = `${databasePath}-wal`;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const network = linuxNetworkTotals();
    const memoryUsed = os.totalmem() - os.freemem();
    const diskTotal = disk.blocks * disk.bsize;
    const diskUsed = diskTotal - disk.bavail * disk.bsize;
    const cpuPercent = cpuUsagePercent();
    const ramPercent = Math.max(0, Math.min(100, (memoryUsed / Math.max(1, os.totalmem())) * 100));
    const diskPercent = Math.max(0, Math.min(100, (diskUsed / Math.max(1, diskTotal)) * 100));
    const lastMetric = await dbGet('SELECT created_at FROM system_metrics ORDER BY id DESC LIMIT 1');
    const lastMetricAt = lastMetric?.created_at ? new Date(`${lastMetric.created_at}Z`).getTime() : 0;
    if (!lastMetricAt || Date.now() - lastMetricAt >= 5 * 60_000) {
      await dbRun(
        `INSERT INTO system_metrics (cpu_percent, ram_percent, disk_percent, rx_bytes, tx_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [cpuPercent, ramPercent, diskPercent, network.rx_bytes, network.tx_bytes],
      );
    }
    const metricHistory = (await dbAll(
      `SELECT cpu_percent, ram_percent, disk_percent, rx_bytes, tx_bytes, created_at
         FROM system_metrics ORDER BY id DESC LIMIT 40`,
    )).reverse();
    res.json({
      status: 'ok',
      server_time: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      process: {
        pid: process.pid,
        node: process.version,
        uptime_seconds: Math.round(process.uptime()),
        rss_bytes: processMemory.rss,
        heap_used_bytes: processMemory.heapUsed,
        heap_total_bytes: processMemory.heapTotal,
      },
      host: {
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        uptime_seconds: Math.round(os.uptime()),
        cpu_count: os.cpus().length,
        cpu_percent: cpuPercent,
        load_average: os.loadavg(),
        memory_total_bytes: os.totalmem(),
        memory_free_bytes: os.freemem(),
        disk_total_bytes: disk.blocks * disk.bsize,
        disk_free_bytes: disk.bavail * disk.bsize,
      },
      database: { path: databasePath, bytes: databaseBytes, wal_bytes: walBytes },
      traffic: {
        realtime_admin_connections: adminStreams.size,
        rate_limit_buckets: rateBuckets.size,
        ...network,
      },
      devices: deviceStats,
      chat: chatStats,
      audit: auditStats,
      metric_interval_seconds: 300,
      metric_history: metricHistory,
      backup: {
        cron_enabled: fs.existsSync('/etc/cron.d/rustdesk-kiosk-backup'),
        google_drive_configured: fs.existsSync('/root/.config/rclone/rclone.conf'),
        last_action: lastBackup?.action || null,
        last_at: lastBackup?.created_at || null,
      },
      recent_failures: recentFailures.map((item) => ({
        ...item,
        details: (() => { try { return JSON.parse(item.details || '{}'); } catch (_error) { return {}; } })(),
      })),
    });
  } catch (error) {
    console.error('Could not build system health:', error);
    fail(res, 500, 'Không thể đọc trạng thái server');
  }
});

app.get('/api/admin/settings/system', requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(`SELECT key, value FROM settings WHERE key IN (
      'audit_retention_days', 'health_refresh_seconds', 'dashboard_refresh_seconds',
      'online_threshold_minutes', 'chat_access_mode', 'device_registration_mode',
      'sos_enabled', 'password_reporting_enabled', 'admin_allowed_ips',
      'transient_retention_days'
    )`);
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    res.json({
      audit_retention_days: Number(values.audit_retention_days) || 180,
      health_refresh_seconds: Number(values.health_refresh_seconds) || 15,
      dashboard_refresh_seconds: Number(values.dashboard_refresh_seconds) || 20,
      online_threshold_minutes: Number(values.online_threshold_minutes) || 5,
      chat_access_mode: values.chat_access_mode === 'key_required' ? 'key_required' : 'open',
      device_registration_mode: values.device_registration_mode === 'closed' ? 'closed' : 'open',
      sos_enabled: values.sos_enabled !== '0',
      password_reporting_enabled: values.password_reporting_enabled !== '0',
      admin_allowed_ips: values.admin_allowed_ips || '',
      transient_retention_days: Number(values.transient_retention_days) === 2 ? 2 : 3,
      current_admin_ip: clientIp(_req),
    });
  } catch (_error) {
    fail(res, 500, 'Không thể tải cấu hình hệ thống');
  }
});

app.post('/api/admin/settings/system', requireAdmin, requireSameOrigin, async (req, res) => {
  const retention = Math.round(Number(req.body.audit_retention_days));
  const refresh = Math.round(Number(req.body.health_refresh_seconds));
  const dashboardRefresh = Math.round(Number(req.body.dashboard_refresh_seconds));
  const onlineThreshold = Math.round(Number(req.body.online_threshold_minutes));
  const chatAccessMode = req.body.chat_access_mode === 'key_required' ? 'key_required' : 'open';
  const registrationMode = req.body.device_registration_mode === 'closed' ? 'closed' : 'open';
  const sosEnabled = req.body.sos_enabled === false ? '0' : '1';
  const passwordReporting = req.body.password_reporting_enabled === false ? '0' : '1';
  const transientRetention = Number(req.body.transient_retention_days) === 2 ? 2 : 3;
  const adminAllowedIps = typeof req.body.admin_allowed_ips === 'string'
    ? [...new Set(req.body.admin_allowed_ips.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))]
    : [];
  if (adminAllowedIps.some((ip) => net.isIP(ip) === 0)) {
    return fail(res, 400, 'Danh sách IP admin có địa chỉ không hợp lệ');
  }
  if (adminAllowedIps.length && !adminAllowedIps.includes(clientIp(req))) {
    return fail(res, 400, `Phải giữ IP hiện tại ${clientIp(req)} trong danh sách để tránh tự khóa`);
  }
  if (retention < 7 || retention > 365 || refresh < 5 || refresh > 120
      || dashboardRefresh < 5 || dashboardRefresh > 120 || onlineThreshold < 1 || onlineThreshold > 30) {
    return fail(res, 400, 'Cấu hình nằm ngoài giới hạn cho phép');
  }
  try {
    await dbRun(`INSERT INTO settings (key, value) VALUES ('audit_retention_days', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(retention)]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('health_refresh_seconds', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(refresh)]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('dashboard_refresh_seconds', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(dashboardRefresh)]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('online_threshold_minutes', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(onlineThreshold)]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('chat_access_mode', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [chatAccessMode]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('device_registration_mode', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [registrationMode]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('sos_enabled', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [sosEnabled]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('password_reporting_enabled', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [passwordReporting]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('admin_allowed_ips', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [adminAllowedIps.join(',')]);
    await dbRun(`INSERT INTO settings (key, value) VALUES ('transient_retention_days', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(transientRetention)]);
    await dbRun("DELETE FROM audit_logs WHERE created_at < datetime('now', ?)", [`-${retention} days`]);
    await cleanupTransientData();
    res.json({
      audit_retention_days: retention,
      health_refresh_seconds: refresh,
      dashboard_refresh_seconds: dashboardRefresh,
      online_threshold_minutes: onlineThreshold,
      chat_access_mode: chatAccessMode,
      device_registration_mode: registrationMode,
      sos_enabled: sosEnabled === '1',
      password_reporting_enabled: passwordReporting === '1',
      admin_allowed_ips: adminAllowedIps.join(','),
      transient_retention_days: transientRetention,
      current_admin_ip: clientIp(req),
    });
  } catch (error) {
    console.error('Could not save system settings:', error);
    fail(res, 500, 'Không thể lưu cấu hình hệ thống');
  }
});

app.post('/api/admin/devices/:id/seat', requireAdmin, requireSameOrigin, async (req, res) => {
  const id = deviceId(req.params.id);
  const seat = seatId(req.body.seat_id);
  if (!id) return fail(res, 400, 'Invalid device ID');
  if (req.body.seat_id && !seat) return fail(res, 400, 'Invalid seat ID');
  try {
    await dbRun('BEGIN IMMEDIATE');
    let result;
    try {
      if (seat) {
        const occupied = await dbGet('SELECT id, hostname FROM devices WHERE seat_id = ? AND id <> ?', [seat, id]);
        if (occupied) {
          await dbRun('ROLLBACK');
          return fail(res, 409, `${seat} đã được gán cho ${occupied.hostname || occupied.id}`, 'SEAT_ALREADY_ASSIGNED');
        }
      }
      result = await dbRun('UPDATE devices SET seat_id = ? WHERE id = ?', [seat, id]);
      if (!result.changes) {
        await dbRun('ROLLBACK');
        return fail(res, 404, 'Device not found');
      }
      await dbRun('UPDATE device_keys SET seat_id = ? WHERE device_id = ? AND active = 1', [seat, id]);
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    emitAdminEvent('device-updated', { device_id: id, seat_id: seat });
    res.json({ result: 'OK', seat_id: seat });
  } catch (error) {
    console.error('Could not update device seat:', error);
    fail(res, 500, 'Database error');
  }
});

app.get('/api/admin/device-keys', requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT k.id, k.key_hint, k.label, k.seat_id, k.device_id, k.mode, k.active,
              k.created_at, k.last_used_at, k.consumed_at, d.hostname
         FROM device_keys k LEFT JOIN devices d ON d.id = k.device_id
        ORDER BY k.active DESC, k.id DESC LIMIT 500`,
    );
    res.json(rows);
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/device-keys', requireAdmin, requireSameOrigin, rateLimit('key-create', 30, 60_000), async (req, res) => {
  const requestedDeviceId = req.body.device_id ? deviceId(req.body.device_id) : null;
  const requestedSeatId = req.body.seat_id ? seatId(req.body.seat_id) : null;
  const mode = req.body.mode === 'one_time' ? 'one_time' : 'bound';
  const label = text(req.body.label, 80) || requestedSeatId || requestedDeviceId || 'Máy chưa đặt tên';
  if (req.body.device_id && !requestedDeviceId) return fail(res, 400, 'Invalid device ID');
  if (req.body.seat_id && !requestedSeatId) return fail(res, 400, 'Invalid seat ID');

  try {
    if (requestedDeviceId) {
      const device = await dbGet('SELECT id FROM devices WHERE id = ?', [requestedDeviceId]);
      if (!device) return fail(res, 404, 'Device not found');
    }

    const rawKey = await generateShortDeviceKey();
    const keyHint = rawKey;

    await dbRun('BEGIN IMMEDIATE');
    let result;
    try {
      if (requestedSeatId) {
        const occupied = await dbGet(
          'SELECT id, hostname FROM devices WHERE seat_id = ? AND (? IS NULL OR id <> ?)',
          [requestedSeatId, requestedDeviceId, requestedDeviceId],
        );
        if (occupied) {
          await dbRun('ROLLBACK');
          return fail(res, 409, `${requestedSeatId} đã được gán cho ${occupied.hostname || occupied.id}`, 'SEAT_ALREADY_ASSIGNED');
        }
      }
      if (requestedDeviceId) {
        await dbRun('UPDATE device_keys SET active = 0 WHERE device_id = ? AND active = 1', [requestedDeviceId]);
      }
      result = await dbRun(
        `INSERT INTO device_keys
          (key_hash, key_hint, label, seat_id, device_id, mode, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          hashDeviceKey(rawKey),
          keyHint,
          label,
          requestedSeatId,
          requestedDeviceId,
          mode,
          requestedDeviceId && mode === 'bound' ? new Date().toISOString() : null,
        ],
      );
      if (requestedDeviceId && mode === 'bound') {
        await dbRun(
          'UPDATE devices SET access_key_id = ?, key_entry_required = 0, seat_id = COALESCE(?, seat_id) WHERE id = ?',
          [result.lastID, requestedSeatId, requestedDeviceId],
        );
      } else if (requestedDeviceId) {
        await dbRun(
          'UPDATE devices SET access_key_id = NULL, key_entry_required = 1, seat_id = COALESCE(?, seat_id) WHERE id = ?',
          [requestedSeatId, requestedDeviceId],
        );
      }
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    emitAdminEvent(mode === 'bound' ? 'device-activated' : 'device-pending', {
      device_id: requestedDeviceId,
      seat_id: requestedSeatId,
      key_id: result.lastID,
      key_label: label,
    });
    res.status(201).json({
      id: result.lastID,
      key: rawKey,
      key_hint: keyHint,
      label,
      seat_id: requestedSeatId,
      device_id: requestedDeviceId,
      mode,
    });
  } catch (error) {
    console.error('Could not create device key:', error);
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/devices/require-key', requireAdmin, requireSameOrigin, rateLimit('key-require', 10, 60_000), async (req, res) => {
  const requestedIds = Array.isArray(req.body.device_ids)
    ? [...new Set(req.body.device_ids.map(deviceId).filter(Boolean))].slice(0, 500)
    : [];
  const scopeAll = req.body.scope === 'all';
  if (!scopeAll && requestedIds.length === 0) return fail(res, 400, 'No devices selected');

  try {
    const targets = scopeAll
      ? await dbAll('SELECT id, hostname, seat_id FROM devices ORDER BY seat_id, hostname')
      : await dbAll(
        `SELECT id, hostname, seat_id FROM devices WHERE id IN (${requestedIds.map(() => '?').join(',')}) ORDER BY seat_id, hostname`,
        requestedIds,
      );
    if (!targets.length) return fail(res, 404, 'Device not found');

    const generated = [];
    await dbRun('BEGIN IMMEDIATE');
    try {
      for (const target of targets) {
        await dbRun('UPDATE device_keys SET active = 0 WHERE device_id = ? AND active = 1', [target.id]);
        await dbRun('UPDATE devices SET access_key_id = NULL, key_entry_required = 1 WHERE id = ?', [target.id]);
        const rawKey = await generateShortDeviceKey();
        const keyHint = rawKey;
        const label = `Xác thực lại · ${target.seat_id || target.hostname || target.id}`;
        const result = await dbRun(
          `INSERT INTO device_keys (key_hash, key_hint, label, seat_id, device_id, mode)
           VALUES (?, ?, ?, ?, ?, 'one_time')`,
          [hashDeviceKey(rawKey), keyHint, label, target.seat_id || null, target.id],
        );
        generated.push({
          id: result.lastID,
          key: rawKey,
          device_id: target.id,
          hostname: target.hostname,
          seat_id: target.seat_id,
        });
      }
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    emitAdminEvent('device-pending', { scope: scopeAll ? 'all' : 'selected', device_ids: targets.map((item) => item.id) });
    res.status(201).json({ generated });
  } catch (error) {
    console.error('Could not require new device keys:', error);
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/devices/cancel-key-requirement', requireAdmin, requireSameOrigin, rateLimit('key-cancel', 20, 60_000), async (req, res) => {
  const requestedIds = Array.isArray(req.body.device_ids)
    ? [...new Set(req.body.device_ids.map(deviceId).filter(Boolean))].slice(0, 500)
    : [];
  const scopeAll = req.body.scope === 'all';
  if (!scopeAll && requestedIds.length === 0) return fail(res, 400, 'No devices selected');

  try {
    const targets = scopeAll
      ? await dbAll('SELECT id, hostname, seat_id FROM devices WHERE key_entry_required = 1 ORDER BY seat_id, hostname')
      : await dbAll(
        `SELECT id, hostname, seat_id FROM devices
          WHERE key_entry_required = 1 AND id IN (${requestedIds.map(() => '?').join(',')})
          ORDER BY seat_id, hostname`,
        requestedIds,
      );
    if (!targets.length) return fail(res, 404, 'Không có máy nào đang bị ép nhập key');

    await dbRun('BEGIN IMMEDIATE');
    try {
      for (const target of targets) {
        await dbRun('UPDATE device_keys SET active = 0 WHERE device_id = ? AND active = 1', [target.id]);
        const rawKey = `AUTO-${crypto.randomBytes(24).toString('base64url')}`;
        const keyHint = `AUTO…${rawKey.slice(-5)}`;
        const label = `Tự động · ${target.seat_id || target.hostname || target.id}`;
        const result = await dbRun(
          `INSERT INTO device_keys
            (key_hash, key_hint, label, seat_id, device_id, mode, last_used_at)
           VALUES (?, ?, ?, ?, ?, 'bound', CURRENT_TIMESTAMP)`,
          [hashDeviceKey(rawKey), keyHint, label, target.seat_id || null, target.id],
        );
        await dbRun(
          'UPDATE devices SET access_key_id = ?, key_entry_required = 0 WHERE id = ?',
          [result.lastID, target.id],
        );
      }
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }

    emitAdminEvent('device-activated', {
      scope: scopeAll ? 'all' : 'selected',
      device_ids: targets.map((item) => item.id),
    });
    res.json({ updated: targets.length, device_ids: targets.map((item) => item.id) });
  } catch (error) {
    console.error('Could not cancel key requirement:', error);
    fail(res, 500, 'Database error');
  }
});

app.put('/api/admin/device-keys/:id', requireAdmin, requireSameOrigin, rateLimit('key-edit', 30, 60_000), async (req, res) => {
  const keyId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  const rawKey = editableDeviceKey(req.body.key);
  if (!keyId) return fail(res, 400, 'Invalid key id');
  if (!rawKey) return fail(res, 400, 'Key phải gồm 8-16 chữ hoặc số, không có khoảng trắng');

  try {
    const keyHash = hashDeviceKey(rawKey);
    const duplicate = await dbGet('SELECT id FROM device_keys WHERE key_hash = ? AND id <> ?', [keyHash, keyId]);
    if (duplicate) return fail(res, 409, 'Key này đã được sử dụng');
    const result = await dbRun(
      `UPDATE device_keys SET key_hash = ?, key_hint = ?
        WHERE id = ? AND active = 1 AND consumed_at IS NULL`,
      [keyHash, rawKey, keyId],
    );
    if (!result.changes) return fail(res, 404, 'Không tìm thấy key đang hoạt động để sửa');
    emitAdminEvent('device-key-updated', { key_id: keyId, key_hint: rawKey });
    res.json({ id: keyId, key: rawKey, key_hint: rawKey });
  } catch (error) {
    console.error('Could not update device key:', error);
    if (error?.code === 'SQLITE_CONSTRAINT') return fail(res, 409, 'Key này đã được sử dụng');
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/device-keys/:id/revoke', requireAdmin, requireSameOrigin, async (req, res) => {
  const keyId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  if (!keyId) return fail(res, 400, 'Invalid key id');
  try {
    await dbRun('BEGIN IMMEDIATE');
    let result;
    try {
      result = await dbRun('UPDATE device_keys SET active = 0 WHERE id = ? AND active = 1', [keyId]);
      if (result.changes) {
        await dbRun('UPDATE devices SET access_key_id = NULL, key_entry_required = 0 WHERE access_key_id = ?', [keyId]);
      }
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    if (!result.changes) return fail(res, 404, 'Key not found or already revoked');
    emitAdminEvent('device-key-revoked', { key_id: keyId });
    res.json({ success: true });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/device/sos', requireRegisteredDevice, rateLimit('device-sos', 6, 60_000), async (req, res) => {
  const body = 'SOS · Yêu cầu cứu hộ khẩn cấp từ phím tắt';
  try {
    if (await settingValue('sos_enabled', '1') === '0') {
      return fail(res, 403, 'SOS đang bị tắt bởi quản trị viên', 'SOS_DISABLED');
    }
    const result = await dbRun(
      'INSERT INTO chat_messages (channel, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)',
      ['boss', req.deviceId, req.deviceId, body],
    );
    const alert = await createChatAlert(result.lastID, req.deviceId, body, 'boss', {
      priority: 'urgent',
      matchedKeyword: 'hotkey-sos',
    });
    emitAdminEvent('device-sos', {
      device_id: req.deviceId,
      seat_id: req.device.seat_id || null,
      alert_id: alert?.id || null,
    });
    res.status(201).json({ accepted: true, alert_id: alert?.id || null });
  } catch (error) {
    console.error('Could not create device SOS:', error);
    fail(res, 500, 'Database error');
  }
});

app.get('/api/chat/messages', requireDevice, rateLimit('device-read', 240, 60_000), async (req, res) => {
  const channel = req.query.channel === 'global' ? 'global' : 'boss';
  const afterId = Math.max(0, Number.parseInt(req.query.after_id, 10) || 0);
  const params = channel === 'global' ? [channel, afterId] : [channel, req.deviceId, afterId];
  const query = channel === 'global'
    ? 'SELECT id, channel, sender_id, body, created_at FROM chat_messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT 100'
    : 'SELECT id, channel, sender_id, body, created_at FROM chat_messages WHERE channel = ? AND recipient_id = ? AND id > ? ORDER BY id ASC LIMIT 100';
  try {
    res.json(await dbAll(query, params));
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/chat/messages', requireDevice, rateLimit('device-message', 30, 60_000), async (req, res) => {
  const channel = req.body.channel === 'global' ? 'global' : 'boss';
  const body = text(req.body.body, 2000);
  if (!body) return fail(res, 400, 'Message must contain between 1 and 2000 characters');
  const recipient = channel === 'boss' ? req.deviceId : null;
  try {
    const result = await dbRun(
      'INSERT INTO chat_messages (channel, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)',
      [channel, req.deviceId, recipient, body],
    );
    await createChatAlert(result.lastID, req.deviceId, body, channel);
    res.status(201).json({ id: result.lastID });
  } catch (error) {
    console.error('Could not save chat message:', error);
    fail(res, 500, 'Database error');
  }
});

app.get('/api/admin/chat/messages', requireAdmin, async (req, res) => {
  const channel = req.query.channel === 'global' ? 'global' : 'boss';
  const afterId = Math.max(0, Number.parseInt(req.query.after_id, 10) || 0);
  const selectedDeviceId = deviceId(req.query.device_id);
  if (channel === 'boss' && !selectedDeviceId) return fail(res, 400, 'device_id is required for boss chat');
  const params = channel === 'global' ? [channel, afterId] : [channel, selectedDeviceId, afterId];
  const query = channel === 'global'
    ? 'SELECT id, channel, sender_id, recipient_id, body, created_at FROM chat_messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT 100'
    : 'SELECT id, channel, sender_id, recipient_id, body, created_at FROM chat_messages WHERE channel = ? AND recipient_id = ? AND id > ? ORDER BY id ASC LIMIT 100';
  try {
    res.json(await dbAll(query, params));
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.delete('/api/admin/chat/messages', requireAdmin, requireSameOrigin, rateLimit('chat-emergency-delete', 5, 60_000), async (req, res) => {
  const scope = req.body.scope === 'device' ? 'device' : req.body.scope === 'all' ? 'all' : null;
  const targetDeviceId = scope === 'device' ? deviceId(req.body.device_id) : null;
  if (req.body.confirmation !== 'DELETE_CHAT') return fail(res, 400, 'Thiếu xác nhận xóa chat');
  if (!scope || (scope === 'device' && !targetDeviceId)) return fail(res, 400, 'Phạm vi xóa không hợp lệ');
  try {
    await dbRun('BEGIN IMMEDIATE');
    let deletedMessages;
    try {
      if (scope === 'all') {
        await dbRun('DELETE FROM chat_alerts');
        deletedMessages = await dbRun('DELETE FROM chat_messages');
      } else {
        await dbRun(
          `DELETE FROM chat_alerts
            WHERE message_id IN (
              SELECT id FROM chat_messages WHERE sender_id = ? OR recipient_id = ?
            )`,
          [targetDeviceId, targetDeviceId],
        );
        deletedMessages = await dbRun(
          'DELETE FROM chat_messages WHERE sender_id = ? OR recipient_id = ?',
          [targetDeviceId, targetDeviceId],
        );
      }
      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
    emitAdminEvent('chat-deleted', {
      scope,
      device_id: targetDeviceId,
      deleted_messages: deletedMessages.changes,
    });
    res.json({ deleted: true, scope, device_id: targetDeviceId, deleted_messages: deletedMessages.changes });
  } catch (error) {
    console.error('Could not delete chat history:', error);
    fail(res, 500, 'Không thể xóa lịch sử chat');
  }
});

app.post('/api/admin/chat/messages', requireAdmin, requireSameOrigin, rateLimit('admin-message', 120, 60_000), async (req, res) => {
  const channel = req.body.channel === 'global' ? 'global' : 'boss';
  const recipient = channel === 'boss' ? deviceId(req.body.device_id) : null;
  const body = text(req.body.body, 2000);
  if (!body || (channel === 'boss' && !recipient)) return fail(res, 400, 'Invalid message payload');
  try {
    const result = await dbRun(
      'INSERT INTO chat_messages (channel, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)',
      [channel, 'boss', recipient, body],
    );
    res.status(201).json({ id: result.lastID });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.get('/api/admin/chat/alerts', requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT a.id, a.message_id, a.device_id, a.matched_keyword, a.priority,
              a.seat_id, a.key_id, a.acknowledged, a.created_at, m.channel, m.body,
              COALESCE(d.hostname, a.device_id) AS hostname,
              k.label AS key_label, k.key_hint
         FROM chat_alerts a
         JOIN chat_messages m ON m.id = a.message_id
         LEFT JOIN devices d ON d.id = a.device_id
         LEFT JOIN device_keys k ON k.id = a.key_id
        WHERE a.acknowledged = 0
        ORDER BY CASE a.priority WHEN 'urgent' THEN 0 ELSE 1 END, a.id DESC LIMIT 200`,
    );
    res.json(rows);
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/chat/alerts/:id/acknowledge', requireAdmin, requireSameOrigin, async (req, res) => {
  const alertId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  if (!alertId) return fail(res, 400, 'Invalid alert id');
  try {
    const result = await dbRun('UPDATE chat_alerts SET acknowledged = 1 WHERE id = ?', [alertId]);
    if (!result.changes) return fail(res, 404, 'Alert not found');
    emitAdminEvent('alert-acknowledged', { id: alertId });
    res.json({ success: true });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.get('/api/admin/settings/keywords', requireAdmin, (_req, res) => {
  res.json({ keywords: alertKeywords.join(', ') });
});

app.post('/api/admin/settings/keywords', requireAdmin, requireSameOrigin, async (req, res) => {
  const newKeywords = parseKeywords(typeof req.body.keywords === 'string' ? req.body.keywords : '');
  const serialized = newKeywords.join(', ');
  try {
    await dbRun(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['alert_keywords', serialized],
    );
    alertKeywords = newKeywords;
    res.json({ success: true, keywords: serialized });
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.use('/api', (_req, res) => fail(res, 404, 'API endpoint not found'));
app.use((error, _req, res, _next) => {
  console.error('Unhandled request error:', error);
  if (!res.headersSent) fail(res, 500, 'Internal server error');
});

async function startServer(listenPort = port) {
  await databaseReady;
  return new Promise((resolve) => {
    const httpServer = app.listen(listenPort, () => {
      const address = httpServer.address();
      console.log(`RustDesk kiosk API listening on port ${address.port}`);
      console.log(`Chat alert keywords: ${alertKeywords.join(', ')}`);
      if (!adminPasswordHash) console.warn('ADMIN_PASSWORD_HASH is missing: admin dashboard is locked.');
      resolve(httpServer);
    });
  });
}

async function closeDatabase() {
  await new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Could not start server:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, startServer, closeDatabase, databaseReady };
