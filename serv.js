const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Настройки CORS для Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "https://cosatka-clickgame-277-p2.netlify.app/",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Настройки CORS для Express
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://cosatka-clickgame-277-p2.netlify.app/');
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
            autoPower: playerData.autoPower || 0,
            currentSkin: playerData.currentSkin || 'default',
            ownedSkins: playerData.ownedSkins || ['default']
        };
        
        players.push(player);
        
        // Отправляем обновленный список игроков всем
        io.emit('players-list', players);
        
        // Уведомляем о новом игроке
        socket.broadcast.emit('player-joined', player);
        
        console.log(`Игрок ${player.name} присоединился к игре`);
    });

    // Обработчик смены скина
    socket.on('skin-change', (data) => {
        const player = players.find(p => p.name === data.playerName);
        if (player) {
            player.currentSkin = data.skinId;
            socket.broadcast.emit('player-skin-changed', {
                playerName: data.playerName,
                skinId: data.skinId
            });
        }
    });

    // Обработчик обновления данных игрока
    socket.on('player-update', (playerData) => {
        const player = players.find(p => p.name === playerData.name);
        if (player) {
            player.resources = playerData.resources;
            player.clickPower = playerData.clickPower;
            player.autoPower = playerData.autoPower;
            player.currentSkin = playerData.currentSkin;
            player.ownedSkins = playerData.ownedSkins;
            
            io.emit('players-list', players);
        }
    });

    // Обработчик сообщений чата
    socket.on('chat-message', (data) => {
        if (isValidMessage(data.message)) {
            io.emit('chat-message', data);
        } else {
            socket.emit('chat-message', {
                sender: 'Система',
                message: 'Ваше сообщение содержит запрещенный контент.'
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
        io.emit('battle-end', data);
        io.emit('chat-message', {
            sender: 'Система',
            message: `Бой завершен! ${data.winner} победил ${data.loser}!`
        });
    });

    // Обработчик отключения игрока
    socket.on('disconnect', () => {
        const playerIndex = players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== -1) {
            const disconnectedPlayer = players[playerIndex];
            players.splice(playerIndex, 1);
            
            io.emit('players-list', players);
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
    if (message.length > 200) return false;
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