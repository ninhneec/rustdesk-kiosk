const crypto = require('crypto');
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = Number(process.env.PORT || 3000);
const adminToken = process.env.ADMIN_TOKEN || '';
const sessionSecret = process.env.CHAT_SESSION_SECRET || adminToken;
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
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
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
  await addColumnIfMissing('devices', 'seat_id', 'TEXT');
  await addColumnIfMissing('devices', 'access_key_id', 'INTEGER');
  await addColumnIfMissing('devices', 'key_entry_required', 'INTEGER NOT NULL DEFAULT 0');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_devices_seat ON devices(seat_id)');

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

  await dbRun(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
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
  return seat && /^[A-Za-z0-9._-]+$/.test(seat) ? seat.toUpperCase() : null;
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

function hashDeviceKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function requireAdmin(req, res, next) {
  if (!adminToken || !sessionSecret) return fail(res, 503, 'Admin access is not configured');
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

async function requireDevice(req, res, next) {
  const id = deviceId(req.get('x-device-id'));
  const suppliedToken = token(req.get('x-device-token'));
  if (!id || !suppliedToken) return fail(res, 401, 'Missing device credentials');
  try {
    const row = await dbGet(
      `SELECT d.chat_token, d.access_key_id, d.seat_id, d.key_entry_required, k.active AS key_active
         FROM devices d LEFT JOIN device_keys k ON k.id = d.access_key_id
        WHERE d.id = ?`,
      [id],
    );
    if (!row || !safeEqual(row.chat_token || '', suppliedToken)) return fail(res, 401, 'Unauthorized');
    if (!row.access_key_id || row.key_active !== 1) {
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
  } catch (error) {
    console.error('Device authentication failed:', error);
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

async function createChatAlert(messageId, senderId, body, channel) {
  if (senderId === 'boss') return null;
  const keyword = matchedAlertKeyword(body);
  const priority = keyword ? 'urgent' : 'normal';
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

app.post('/api/admin/session', rateLimit('admin-login', 8, 15 * 60_000), (req, res) => {
  const suppliedToken = text(req.body.token, 512) || '';
  if (!adminToken || !safeEqual(adminToken, suppliedToken)) return fail(res, 401, 'Sai mã quản trị');
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
  const activationKey = token(req.body.activation_key);
  if (!id || !chatToken) return fail(res, 400, 'Invalid device payload');

  try {
    const existing = await dbGet(
      `SELECT d.chat_token, d.access_key_id, d.seat_id, d.key_entry_required, k.active AS key_active
         FROM devices d LEFT JOIN device_keys k ON k.id = d.access_key_id
        WHERE d.id = ?`,
      [id],
    );
    const credentialsMatch = existing && safeEqual(existing.chat_token || '', chatToken);
    if (credentialsMatch) {
      await dbRun(
        `UPDATE devices SET pass = CASE WHEN ? = '' THEN pass ELSE ? END,
          hostname = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
        [pass, pass, hostname, id],
      );
      const activated = Boolean(existing.access_key_id && existing.key_active === 1);
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
        `INSERT INTO devices (id, pass, hostname, chat_token, key_entry_required, last_seen)
         VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
        [id, pass, hostname, chatToken],
      );
      emitAdminEvent('device-pending', { device_id: id, hostname });
      return res.status(202).json({ result: 'PENDING', activated: false, key_entry_required: false });
    }

    // Retain server-side activation support for automated provisioning tools.
    const keyRow = await dbGet(
      'SELECT * FROM device_keys WHERE key_hash = ? AND active = 1 AND consumed_at IS NULL',
      [hashDeviceKey(activationKey)],
    );
    if (!keyRow) return fail(res, 403, 'Key kích hoạt không hợp lệ hoặc đã bị thu hồi', 'INVALID_ACTIVATION_KEY');
    if (keyRow.device_id && keyRow.device_id !== id) {
      return fail(res, 409, 'Key đã được gắn với một máy khác', 'KEY_ALREADY_BOUND');
    }

    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `INSERT INTO devices (id, pass, hostname, chat_token, seat_id, access_key_id, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           pass = CASE WHEN excluded.pass = '' THEN devices.pass ELSE excluded.pass END,
           hostname = excluded.hostname,
           chat_token = excluded.chat_token,
           seat_id = COALESCE(excluded.seat_id, devices.seat_id),
           access_key_id = excluded.access_key_id,
           key_entry_required = 0,
           last_seen = CURRENT_TIMESTAMP`,
        [id, pass, hostname, chatToken, keyRow.seat_id || null, keyRow.id],
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
      `SELECT d.id, d.pass, d.hostname, d.seat_id, d.last_seen, d.access_key_id, d.key_entry_required,
              k.label AS key_label, k.key_hint, k.active AS key_active
         FROM devices d LEFT JOIN device_keys k ON k.id = d.access_key_id
        ORDER BY d.last_seen DESC`,
    );
    res.json(rows);
  } catch (_error) {
    fail(res, 500, 'Database error');
  }
});

app.post('/api/admin/devices/:id/seat', requireAdmin, requireSameOrigin, async (req, res) => {
  const id = deviceId(req.params.id);
  const seat = seatId(req.body.seat_id);
  if (!id) return fail(res, 400, 'Invalid device ID');
  try {
    const result = await dbRun('UPDATE devices SET seat_id = ? WHERE id = ?', [seat, id]);
    if (!result.changes) return fail(res, 404, 'Device not found');
    await dbRun('UPDATE device_keys SET seat_id = ? WHERE device_id = ? AND active = 1', [seat, id]);
    emitAdminEvent('device-updated', { device_id: id, seat_id: seat });
    res.json({ result: 'OK', seat_id: seat });
  } catch (_error) {
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

  const rawKey = `RDK-${crypto.randomBytes(24).toString('base64url')}`;
  const keyHint = `${rawKey.slice(0, 8)}…${rawKey.slice(-5)}`;
  try {
    if (requestedDeviceId) {
      const device = await dbGet('SELECT id FROM devices WHERE id = ?', [requestedDeviceId]);
      if (!device) return fail(res, 404, 'Device not found');
    }

    await dbRun('BEGIN IMMEDIATE');
    let result;
    try {
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
        const rawKey = `RDK-${crypto.randomBytes(24).toString('base64url')}`;
        const keyHint = `${rawKey.slice(0, 8)}…${rawKey.slice(-5)}`;
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
      if (!adminToken) console.warn('ADMIN_TOKEN is missing: admin dashboard is locked.');
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
