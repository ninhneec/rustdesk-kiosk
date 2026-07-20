const crypto = require('crypto');
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = Number(process.env.PORT || 3000);
const adminToken = process.env.ADMIN_TOKEN || '';
let alertKeywords = [];
const defaultKeywords = 'khẩn cấp,cứu,nguy hiểm,help,sos';

function parseKeywords(str) {
  return [...new Set(
    (str || '')
      .split(',')
      .map((keyword) => keyword.trim().normalize('NFC').toLocaleLowerCase('vi'))
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length);
}
alertKeywords = parseKeywords(process.env.ALERT_KEYWORDS || defaultKeywords);
const db = new sqlite3.Database(path.join(__dirname, 'devices.db'));

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    pass TEXT,
    hostname TEXT,
    chat_token TEXT,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.all('PRAGMA table_info(devices)', (err, columns) => {
    if (err || columns.some((column) => column.name === 'chat_token')) return;
    db.run('ALTER TABLE devices ADD COLUMN chat_token TEXT');
  });
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL CHECK(channel IN ('boss', 'global')),
    sender_id TEXT NOT NULL,
    recipient_id TEXT,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON chat_messages(channel, created_at, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient_created ON chat_messages(recipient_id, created_at, id)');
  db.run(`CREATE TABLE IF NOT EXISTS chat_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    matched_keyword TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES chat_messages(id)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_chat_alerts_active ON chat_alerts(acknowledged, id)');

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  db.get('SELECT value FROM settings WHERE key = ?', ['alert_keywords'], (err, row) => {
    if (!err && row && row.value) {
      alertKeywords = parseKeywords(row.value);
    } else {
      const initialKeywords = process.env.ALERT_KEYWORDS || defaultKeywords;
      db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', ['alert_keywords', initialKeywords]);
      alertKeywords = parseKeywords(initialKeywords);
    }
  });
});

function fail(res, status, error) {
  return res.status(status).json({ error });
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

function token(value) {
  const valueAsText = text(value, 256);
  return valueAsText && /^[A-Za-z0-9_-]+$/.test(valueAsText) ? valueAsText : null;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
  }) || null;
}

function createChatAlert(messageId, senderId, body) {
  const keyword = matchedAlertKeyword(body);
  if (!keyword || senderId === 'boss') return;
  db.run(
    'INSERT OR IGNORE INTO chat_alerts (message_id, device_id, matched_keyword) VALUES (?, ?, ?)',
    [messageId, senderId, keyword],
    (err) => {
      if (err) console.error('Could not create chat alert:', err);
    },
  );
}

function requireAdmin(req, res, next) {
  if (!adminToken) return fail(res, 503, 'ADMIN_TOKEN is not configured');
  const authorization = req.get('authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!safeEqual(adminToken, suppliedToken)) return fail(res, 401, 'Unauthorized');
  next();
}

function requireDevice(req, res, next) {
  const id = deviceId(req.get('x-device-id'));
  const suppliedToken = token(req.get('x-device-token'));
  if (!id || !suppliedToken) return fail(res, 401, 'Missing device credentials');

  db.get('SELECT chat_token FROM devices WHERE id = ?', [id], (err, row) => {
    if (err) return fail(res, 500, 'Database error');
    if (!row || !safeEqual(row.chat_token || '', suppliedToken)) return fail(res, 401, 'Unauthorized');
    req.deviceId = id;
    next();
  });
}

// The RustDesk client registers itself every 30 seconds. An existing machine's
// token cannot be replaced remotely, which prevents a guessed ID being hijacked.
app.post('/api/device/save-password', (req, res) => {
  const id = deviceId(req.body.id);
  const pass = typeof req.body.pass === 'string' ? text(req.body.pass, 512) : '';
  const hostname = text(req.body.hostname, 255) || 'Unknown';
  const chatToken = token(req.body.chat_token);
  
  if (!id || !chatToken) {
    console.error(`[API] Invalid device payload. id=${id}, chat_token=${chatToken}`);
    return fail(res, 400, 'Invalid device payload');
  }

  // If password is empty, don't overwrite existing password with empty.
  const query = pass 
    ? `INSERT INTO devices (id, pass, hostname, chat_token, last_seen)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET 
         pass = excluded.pass, 
         hostname = excluded.hostname, 
         chat_token = excluded.chat_token,
         last_seen = CURRENT_TIMESTAMP`
    : `INSERT INTO devices (id, pass, hostname, chat_token, last_seen)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET 
         hostname = excluded.hostname, 
         chat_token = excluded.chat_token,
         last_seen = CURRENT_TIMESTAMP`;

  const args = pass ? [id, pass, hostname, chatToken] : [id, '', hostname, chatToken];

  db.run(query, args, (err) => {
    if (err) {
      console.error(`[API] Database error saving device ${id}:`, err.message);
      return fail(res, 500, 'Database error');
    }
    console.log(`[API] Device pinged successfully: ${id} (${hostname})`);
    res.json({ result: 'OK' });
  });
});

app.get('/api/admin/devices', requireAdmin, (_req, res) => {
  db.all('SELECT id, pass, hostname, last_seen FROM devices ORDER BY last_seen DESC', [], (err, rows) => {
    if (err) return fail(res, 500, 'Database error');
    res.json(rows);
  });
});

app.get('/api/chat/messages', requireDevice, (req, res) => {
  const channel = req.query.channel === 'global' ? 'global' : 'boss';
  const afterId = Math.max(0, Number.parseInt(req.query.after_id, 10) || 0);
  const params = channel === 'global'
    ? [channel, afterId]
    : [channel, req.deviceId, afterId];
  const query = channel === 'global'
    ? 'SELECT id, channel, sender_id, body, created_at FROM chat_messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT 100'
    : 'SELECT id, channel, sender_id, body, created_at FROM chat_messages WHERE channel = ? AND recipient_id = ? AND id > ? ORDER BY id ASC LIMIT 100';
  db.all(query, params, (err, rows) => {
    if (err) return fail(res, 500, 'Database error');
    res.json(rows);
  });
});

app.post('/api/chat/messages', requireDevice, (req, res) => {
  const channel = req.body.channel === 'global' ? 'global' : 'boss';
  const body = text(req.body.body, 2000);
  if (!body) return fail(res, 400, 'Message must contain between 1 and 2000 characters');

  const recipient = channel === 'boss' ? req.deviceId : null;
  db.run(
    'INSERT INTO chat_messages (channel, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)',
    [channel, req.deviceId, recipient, body],
    function onMessageSaved(err) {
      if (err) return fail(res, 500, 'Database error');
      createChatAlert(this.lastID, req.deviceId, body);
      res.status(201).json({ id: this.lastID });
    },
  );
});

app.get('/api/admin/chat/messages', requireAdmin, (req, res) => {
  const channel = req.query.channel === 'global' ? 'global' : 'boss';
  const afterId = Math.max(0, Number.parseInt(req.query.after_id, 10) || 0);
  const selectedDeviceId = deviceId(req.query.device_id);
  if (channel === 'boss' && !selectedDeviceId) return fail(res, 400, 'device_id is required for boss chat');
  const params = channel === 'global' ? [channel, afterId] : [channel, selectedDeviceId, afterId];
  const query = channel === 'global'
    ? 'SELECT id, channel, sender_id, recipient_id, body, created_at FROM chat_messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT 100'
    : 'SELECT id, channel, sender_id, recipient_id, body, created_at FROM chat_messages WHERE channel = ? AND recipient_id = ? AND id > ? ORDER BY id ASC LIMIT 100';
  db.all(query, params, (err, rows) => {
    if (err) return fail(res, 500, 'Database error');
    res.json(rows);
  });
});

app.post('/api/admin/chat/messages', requireAdmin, (req, res) => {
  const channel = req.body.channel === 'global' ? 'global' : 'boss';
  const recipient = channel === 'boss' ? deviceId(req.body.device_id) : null;
  const body = text(req.body.body, 2000);
  if (!body || (channel === 'boss' && !recipient)) return fail(res, 400, 'Invalid message payload');
  db.run(
    'INSERT INTO chat_messages (channel, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)',
    [channel, 'boss', recipient, body],
    function onMessageSaved(err) {
      if (err) return fail(res, 500, 'Database error');
      res.status(201).json({ id: this.lastID });
    },
  );
});

app.get('/api/admin/chat/alerts', requireAdmin, (req, res) => {
  const afterId = Math.max(0, Number.parseInt(req.query.after_id, 10) || 0);
  db.all(
    `SELECT a.id, a.message_id, a.device_id, a.matched_keyword,
            a.acknowledged, a.created_at, m.channel, m.body,
            COALESCE(d.hostname, a.device_id) AS hostname
       FROM chat_alerts a
       JOIN chat_messages m ON m.id = a.message_id
       LEFT JOIN devices d ON d.id = a.device_id
      WHERE a.id > ? AND a.acknowledged = 0
      ORDER BY a.id DESC LIMIT 100`,
    [afterId],
    (err, rows) => {
      if (err) return fail(res, 500, 'Database error');
      res.json(rows);
    },
  );
});

app.post('/api/admin/chat/alerts/:id/acknowledge', requireAdmin, (req, res) => {
  const alertId = Math.max(0, Number.parseInt(req.params.id, 10) || 0);
  if (!alertId) return fail(res, 400, 'Invalid alert id');
  db.run('UPDATE chat_alerts SET acknowledged = 1 WHERE id = ?', [alertId], function onAcknowledged(err) {
    if (err) return fail(res, 500, 'Database error');
    if (this.changes === 0) return fail(res, 404, 'Alert not found');
    res.json({ success: true });
  });
});

app.get('/api/admin/settings/keywords', requireAdmin, (req, res) => {
  res.json({ keywords: alertKeywords.join(', ') });
});

app.post('/api/admin/settings/keywords', requireAdmin, (req, res) => {
  const keywordsStr = typeof req.body.keywords === 'string' ? req.body.keywords : '';
  const newKeywords = parseKeywords(keywordsStr);
  const newKeywordsStr = newKeywords.join(', ');
  
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['alert_keywords', newKeywordsStr],
    (err) => {
      if (err) return fail(res, 500, 'Database error');
      alertKeywords = newKeywords;
      res.json({ success: true, keywords: newKeywordsStr });
    }
  );
});

app.listen(port, () => {
  if (!adminToken) console.warn('ADMIN_TOKEN is not set: dashboard data and boss chat are disabled.');
  console.log(`RustDesk kiosk API listening on port ${port}`);
  console.log(`Chat alert keywords: ${alertKeywords.join(', ')}`);
});
