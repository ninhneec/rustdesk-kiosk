const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Khởi tạo Database SQLite
const db = new sqlite3.Database('./devices.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            pass TEXT,
            hostname TEXT,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// API: Cập nhật hoặc thêm thiết bị mới
app.post('/api/device/save-password', (req, res) => {
    const { id, pass, hostname } = req.body;
    if (!id || !pass) {
        return res.status(400).json({ error: 'Missing id or password' });
    }

    const query = `
        INSERT INTO devices (id, pass, hostname, last_seen)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET 
            pass = excluded.pass,
            hostname = excluded.hostname,
            last_seen = CURRENT_TIMESTAMP
    `;

    db.run(query, [id, pass, hostname || 'Unknown'], function (err) {
        if (err) {
            console.error('Error saving device:', err.message);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, message: 'Device saved successfully' });
    });
});

// API: Lấy danh sách thiết bị
app.get('/api/devices', (req, res) => {
    db.all(`SELECT * FROM devices ORDER BY last_seen DESC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
