const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Настройки CORS для Socket.IO
const io = socketIo(server, {
  cors: {
    origin: [
      "https://cosatka-clickgame-277-p2.netlify.app",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Настройки CORS для Express
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://cosatka-clickgame-277-p2.netlify.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Раздаем статические файлы из текущей директории
app.use(express.static(path.join(__dirname)));

// Отправляем index.html для корневого пути
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// Данные игроков
let players = [];

// Обработка подключений
io.on('connection', (socket) => {
console.log('Новый игрок подключился:', socket.id);
    
    // Обработчик присоединения игрока
socket.on('player-join', (playerData) => {
    // Проверяем, нет ли уже игрока с таким именем
    const existingPlayer = players.find(p => p.name === playerData.name);
    
    if (existingPlayer) {
        // Если игрок с таким именем уже есть, добавляем суффикс
        playerData.name = playerData.name + '_' + Math.floor(Math.random() * 100);
    }
    
    // Добавляем игрока в список
    const player = {
        id: socket.id,
        name: playerData.name,
        resources: playerData.resources || 0,
        clickPower: playerData.clickPower || 1,
        autoPower: playerData.autoPower || 0
    };
    
    players.push(player);
    
    // Отправляем обновленный список игроков всем
    io.emit('players-list', players);
    
    // Уведомляем о новом игроке
    socket.broadcast.emit('player-joined', player);
    
    console.log(`Игрок ${player.name} присоединился к игре`);
});

// Обработчик добычи ресурсов
socket.on('player-mine', (data) => {
    // Обновляем ресурсы игрока
    const player = players.find(p => p.name === data.name);
    if (player) {
        player.resources += data.mined;
        
        // Отправляем обновленный список игроков
        io.emit('players-list', players);
        
        // Уведомляем о добыче (опционально)
        socket.broadcast.emit('player-mined', data);
    }
});

// Обработчик обновления данных игрока
socket.on('player-update', (playerData) => {
    const player = players.find(p => p.name === playerData.name);
    if (player) {
        player.resources = playerData.resources;
        player.clickPower = playerData.clickPower;
        player.autoPower = playerData.autoPower;
        
        // Отправляем обновленный список игроков
        io.emit('players-list', players);
    }
});

// Обработчик сообщений чата
socket.on('chat-message', (data) => {
    // Проверяем сообщение на наличие запрещенного контента
    if (isValidMessage(data.message)) {
        // Отправляем сообщение всем игрокам
        io.emit('chat-message', data);
    } else {
        // Уведомляем отправителя о нарушении
        socket.emit('chat-message', {
            sender: 'Система',
            message: 'Ваше сообщение содержит запрещенный контент и не было отправлено.'
        });
    }
});

// Обработчик вызова на бой
socket.on('battle-challenge', (data) => {
    const defenderSocket = findSocketByPlayerName(data.defender);
    if (defenderSocket) {
        defenderSocket.emit('battle-challenge', data);
    }
});

// Обработчик принятия боя
socket.on('battle-accept', (data) => {
    const challengerSocket = findSocketByPlayerName(data.challenger);
    if (challengerSocket) {
        challengerSocket.emit('battle-accepted', data);
    }
});

// Обработчик отклонения боя
socket.on('battle-decline', (data) => {
    const challengerSocket = findSocketByPlayerName(data.challenger);
    if (challengerSocket) {
        challengerSocket.emit('battle-declined', data);
    }
});

// Обработчик атаки в бою
socket.on('battle-attack', (data) => {
    const defenderSocket = findSocketByPlayerName(data.defender);
    if (defenderSocket) {
        defenderSocket.emit('battle-attack', data);
    }
});

// Обработчик окончания боя
socket.on('battle-end', (data) => {
    const loserSocket = findSocketByPlayerName(data.loser);
    if (loserSocket) {
        loserSocket.emit('battle-end', data);
    }
    
    // Уведомляем всех о результате боя
    io.emit('chat-message', {
        sender: 'Система',
        message: `Бой завершен! ${data.winner} победил ${data.loser} в космической битве!`
    });
});

// Обработчик отключения игрока
socket.on('disconnect', () => {
    const playerIndex = players.findIndex(p => p.id === socket.id);
    
    if (playerIndex !== -1) {
        const disconnectedPlayer = players[playerIndex];
        players.splice(playerIndex, 1);
        
        // Отправляем обновленный список игроков
        io.emit('players-list', players);
        
        // Уведомляем о выходе игрока
        socket.broadcast.emit('player-left', disconnectedPlayer);
        
        console.log(`Игрок ${disconnectedPlayer.name} покинул игру`);
    }
});
});

// Поиск сокета по имени игрока
function findSocketByPlayerName(playerName) {
    const player = players.find(p => p.name === playerName);
    if (player) {
        return io.sockets.sockets.get(player.id);
    }
        return null;
    }

// Проверка сообщения на валидность
function isValidMessage(message) {
    // Проверяем длину сообщения
    if (message.length > 200) return false;
    // Проверяем на запрещенные слова (можно расширить)
    const forbiddenWords = ['спам', 'оскорбление', 'реклама'];
    for (let word of forbiddenWords) {
        if (message.toLowerCase().includes(word)) return false;
    }

    return true;
}

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});

