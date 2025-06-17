const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors'); // Добавляем пакет CORS

const app = express();
const server = http.createServer(app);

// Настройки CORS для WebSocket
const wss = new WebSocket.Server({ 
    server,
    verifyClient: (info, done) => {
        // Разрешаем подключения с любых origin (для разработки)
        done(true);
    }
});

// Настройки CORS для Express
const corsOptions = {
    origin: 'https://cosatka-clickgame-277.netlify.app/', // На продакшене замените на конкретные домены
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions)); // Применяем CORS middleware

// Обработка preflight запросов
app.options('*', cors(corsOptions));

// Конфигурация сервера
const PORT = process.env.PORT || 10000;
const GAME_DURATION = 60; // Длительность игры в секундах

// Хранилище данных
const rooms = new Map(); // Все комнаты
const clients = new Map(); // Все подключенные клиенты

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Генерация ID комнаты
function generateRoomId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
    const clientId = crypto.randomBytes(8).toString('hex');
    clients.set(clientId, ws);
    console.log(`Новое подключение: ${clientId}`);

    ws.clientId = clientId;
    ws.roomId = null;
    ws.playerName = null;
    ws.avatar = null;

    // Обработка сообщений от клиента
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleClientMessage(ws, data);
        } catch (e) {
            console.error('Ошибка обработки сообщения:', e);
            sendError(ws, 'Неверный формат сообщения');
        }
    });

    // Обработка закрытия соединения
    ws.on('close', () => {
        console.log(`Соединение закрыто: ${clientId}`);
        handleDisconnect(ws);
        clients.delete(clientId);
    });

    // Обработка ошибок
    ws.on('error', (error) => {
        console.error(`Ошибка WebSocket (${clientId}):`, error);
        handleDisconnect(ws);
        clients.delete(clientId);
    });
});

// Обработка сообщений от клиента
function handleClientMessage(ws, data) {
    if (!data.type) {
        sendError(ws, 'Не указан тип сообщения');
        return;
    }

    switch (data.type) {
        case 'create_room':
            handleCreateRoom(ws, data);
            break;
        case 'join_room':
            handleJoinRoom(ws, data);
            break;
        case 'score_update':
            handleScoreUpdate(ws, data);
            break;
        case 'game_result':
            handleGameResult(ws, data);
            break;
        default:
            sendError(ws, 'Неизвестный тип сообщения');
    }
}

// Создание комнаты
function handleCreateRoom(ws, data) {
    if (ws.roomId) {
        sendError(ws, 'Вы уже находитесь в комнате');
        return;
    }

    const roomId = generateRoomId();
    const room = {
        id: roomId,
        players: [{
            id: ws.clientId,
            name: data.playerName || 'Игрок',
            avatar: data.avatar || 'cat.png',
            score: 0,
            ws: ws
        }],
        timer: null,
        duration: GAME_DURATION,
        timeLeft: GAME_DURATION,
        status: 'waiting' // waiting, playing, finished
    };

    rooms.set(roomId, room);
    ws.roomId = roomId;
    ws.playerName = data.playerName;
    ws.avatar = data.avatar;

    console.log(`Создана комната: ${roomId}`);
    
    // Отправляем ответ создателю комнаты
    ws.send(JSON.stringify({
        type: 'room_created',
        roomId: roomId
    }));
}

// Присоединение к комнате
function handleJoinRoom(ws, data) {
    if (ws.roomId) {
        sendError(ws, 'Вы уже находитесь в комнате');
        return;
    }

    const roomId = data.roomId;
    const room = rooms.get(roomId);

    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }

    if (room.players.length >= 2) {
        sendError(ws, 'Комната уже заполнена');
        return;
    }

    ws.roomId = roomId;
    ws.playerName = data.playerName;
    ws.avatar = data.avatar;

    // Добавляем игрока в комнату
    room.players.push({
        id: ws.clientId,
        name: data.playerName || 'Игрок',
        avatar: data.avatar || 'cat.png',
        score: 0,
        ws: ws
    });

    console.log(`Игрок ${data.playerName} присоединился к комнате ${roomId}`);

    // Уведомляем всех игроков о присоединении
    broadcastToRoom(roomId, {
        type: 'opponent_joined',
        opponent: {
            name: data.playerName,
            avatar: data.avatar,
            playerId: ws.clientId
        }
    });

    // Начинаем игру, если комната заполнена
    if (room.players.length === 2) {
        startGame(room);
    }
}

// Начало игры
function startGame(room) {
    room.status = 'playing';
    room.timeLeft = room.duration;

    console.log(`Начало игры в комнате ${room.id}`);

    // Уведомляем всех игроков о начале игры
    broadcastToRoom(room.id, {
        type: 'game_start',
        duration: room.duration
    });

    // Запускаем таймер игры
    room.timer = setInterval(() => {
        room.timeLeft--;

        // Отправляем обновление времени всем игрокам
        broadcastToRoom(room.id, {
            type: 'timer_update',
            timeLeft: room.timeLeft
        });

        // Завершаем игру, когда время вышло
        if (room.timeLeft <= 0) {
            endGame(room);
        }
    }, 1000);
}

// Обновление счета игрока
function handleScoreUpdate(ws, data) {
    const room = rooms.get(ws.roomId);
    if (!room || room.status !== 'playing') return;

    // Находим игрока в комнате и обновляем его счет
    const player = room.players.find(p => p.id === ws.clientId);
    if (player) {
        player.score = data.score;

        // Отправляем обновление счета оппоненту
        const opponent = room.players.find(p => p.id !== ws.clientId);
        if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(JSON.stringify({
                type: 'score_update',
                playerId: ws.clientId,
                score: data.score
            }));
        }
    }
}

// Завершение игры
function endGame(room) {
    clearInterval(room.timer);
    room.status = 'finished';

    console.log(`Игра завершена в комнате ${room.id}`);

    // Определяем победителя
    const player1 = room.players[0];
    const player2 = room.players[1];
    let result;

    if (player1.score > player2.score) {
        result = {
            isDraw: false,
            winnerId: player1.id,
            player1Score: player1.score,
            player2Score: player2.score
        };
    } else if (player2.score > player1.score) {
        result = {
            isDraw: false,
            winnerId: player2.id,
            player1Score: player1.score,
            player2Score: player2.score
        };
    } else {
        result = {
            isDraw: true,
            player1Score: player1.score,
            player2Score: player2.score
        };
    }

    // Отправляем результат всем игрокам
    broadcastToRoom(room.id, {
        type: 'game_result',
        ...result
    });

    // Через 30 секунд удаляем комнату
    setTimeout(() => {
        rooms.delete(room.id);
        console.log(`Комната ${room.id} удалена`);
    }, 30000);
}

// Обработка результата игры от клиента
function handleGameResult(ws, data) {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    // Можно добавить дополнительную логику проверки результатов
    console.log(`Результат игры в комнате ${room.id} подтвержден`);
}

// Обработка отключения клиента
function handleDisconnect(ws) {
    if (!ws.roomId) return;

    const room = rooms.get(ws.roomId);
    if (!room) return;

    // Удаляем игрока из комнаты
    room.players = room.players.filter(p => p.id !== ws.clientId);

    // Если в комнате остался 1 игрок, уведомляем его о выходе соперника
    if (room.players.length === 1) {
        const remainingPlayer = room.players[0];
        if (remainingPlayer.ws.readyState === WebSocket.OPEN) {
            remainingPlayer.ws.send(JSON.stringify({
                type: 'opponent_left'
            }));
        }
    }

    // Если комната пуста, удаляем ее
    if (room.players.length === 0) {
        clearInterval(room.timer);
        rooms.delete(room.id);
        console.log(`Комната ${room.id} удалена (нет игроков)`);
    }
}

// Отправка сообщения всем в комнате
function broadcastToRoom(roomId, message) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

// Отправка ошибки клиенту
function sendError(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'error',
            message: message
        }));
    }
}


// Запуск сервера
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
