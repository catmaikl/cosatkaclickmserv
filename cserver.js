const express = require('express');
const path = require('path');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = require('http').createServer(app);

// Настройки CORS и Socket.IO
const io = socketIO(server, {
  cors: {
    origin: "",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Обработка корневого маршрута
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Хранилище пользователей
const users = {};

// Обработка соединений Socket.io
io.on('connection', (socket) => {
  console.log('Новое соединение:', socket.id);

  // Обработка входа пользователя
  socket.on('join', (username) => {
    if (Object.values(users).includes(username)) {
      socket.emit('username_taken', 'Это имя уже занято');
      return;
    }

    users[socket.id] = username;
    socket.broadcast.emit('user_joined', username);
    
    socket.emit('welcome', {
      users: Object.values(users),
      message: `Добро пожаловать в чат, ${username}!`
    });
  });

  // Обработка сообщений
  socket.on('chat_message', (data) => {
    const username = users[socket.id];
    if (username && data.message) {
      io.emit('new_chat_message', {
        username,
        message: data.message,
        time: new Date().toLocaleTimeString()
      });
    }
  });

  // Обработка отключения
  socket.on('disconnect', () => {
    const username = users[socket.id];
    if (username) {
      delete users[socket.id];
      io.emit('user_left', username);
    }
  });
});

// Запуск сервера
const PORT = process.env.PORT || 5777;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});