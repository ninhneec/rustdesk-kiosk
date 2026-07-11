const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Connect to SQLite Database
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to the SQLite database.');
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT,
      sender TEXT,
      text TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // User joins a room
  socket.on('join_room', (data) => {
    socket.join(data.room);
    console.log(`User ${socket.id} joined room: ${data.room}`);
    
    // Fetch and send message history for this room
    db.all(`SELECT * FROM messages WHERE room = ? ORDER BY timestamp ASC LIMIT 100`, [data.room], (err, rows) => {
      if (err) {
        console.error(err);
      } else {
        socket.emit('message_history', rows);
      }
    });
  });

  // Handle incoming messages
  socket.on('send_message', (data) => {
    const { room, sender, text } = data;
    
    // Broadcast to everyone in the room
    io.to(room).emit('receive_message', data);
    
    // Save to database
    db.run(`INSERT INTO messages (room, sender, text) VALUES (?, ?, ?)`, [room, sender, text], function(err) {
      if (err) {
        console.error('Error inserting message', err);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server is running on port ${PORT}`);
});
