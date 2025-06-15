const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());

// HTTP-сервер для Express и WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище комнат
const rooms = new Map();

// Генерация ID комнаты
function generateRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Обработка WebSocket-соединений
wss.on('connection', (ws) => {
  console.log('Новое подключение');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      console.error('Ошибка парсинга сообщения:', err);
    }
  });

  ws.on('close', () => {
    console.log('Клиент отключился');
    removePlayerFromRooms(ws);
  });
});

// Обработка сообщений от клиентов
function handleMessage(ws, data) {
  switch (data.type) {
    case 'create_room':
      handleCreateRoom(ws, data);
      break;

    case 'join_room':
      handleJoinRoom(ws, data);
      break;

    case 'start_game':
      handleStartGame(data.roomId);
      break;

    case 'score_update':
      handleScoreUpdate(data.roomId, data.playerId, data.score);
      break;

    default:
      console.warn('Неизвестный тип сообщения:', data.type);
  }
}

// Создание комнаты
function handleCreateRoom(ws, data) {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    players: [{
      ws,
      playerId: data.playerId,
      name: data.playerName,
      avatar: data.avatar,
      score: 0,
    }],
    gameState: 'waiting', // waiting | playing | finished
  });

  ws.send(JSON.stringify({
    type: 'room_created',
    roomId,
  }));

  console.log(`Комната ${roomId} создана`);
}

// Присоединение к комнате
function handleJoinRoom(ws, data) {
  const room = rooms.get(data.roomId);

  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Комната не найдена',
    }));
    return;
  }

  if (room.players.length >= 2) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Комната заполнена',
    }));
    return;
  }

  room.players.push({
    ws,
    playerId: data.playerId,
    name: data.playerName,
    avatar: data.avatar,
    score: 0,
  });

  // Уведомляем всех игроков в комнате
  room.players.forEach(player => {
    player.ws.send(JSON.stringify({
      opponent: {
        name: data.playerName,
        avatar: data.avatar,
      },
      type: 'player_joined',
    }));
  });

  console.log(`Игрок ${data.playerName} присоединился к комнате ${data.roomId}`);
}

// Начало игры
function handleStartGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length !== 2) return;

  room.gameState = 'playing';

  // Собираем данные об оппонентах
  const opponentData = room.players.map(player => ({
    playerId: player.playerId,
    name: player.name,
    avatar: player.avatar,
    score: player.score
  }));

  // Отправляем каждому игроку:
  room.players.forEach((player, index) => {
    const opponent = opponentData[1 - index]; // Получаем данные оппонента
    
    player.ws.send(JSON.stringify({
      type: 'game_start',
      opponent: {
        name: opponent.name,
        avatar: opponent.avatar,
        playerId: opponent.playerId
      },
      duration: 60, // Длительность игры в секундах
      startTime: Date.now() // Время начала для синхронизации
    }));
  });

  // Запускаем игровой таймер
  let timeLeft = 60;
  room.timerInterval = setInterval(() => {
    timeLeft--;

    // Отправляем обновление времени всем игрокам
    room.players.forEach(player => {
      player.ws.send(JSON.stringify({
        type: 'timer_update',
        timeLeft: timeLeft
      }));
    });

    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      endGame(roomId);
    }
  }, 1000);
}

// Обновление счета
function handleScoreUpdate(roomId, playerId, score) {
  const room = rooms.get(roomId);
  if (!room || room.gameState !== 'playing') return;

  const player = room.players.find(p => p.playerId === playerId);
  if (!player) return;

  player.score = score;

  // Отправляем обновление противнику
  const opponent = room.players.find(p => p.playerId !== playerId);
  if (opponent) {
    opponent.ws.send(JSON.stringify({
      type: 'opponent_score_update',
      score,
    }));
  }
}

// Завершение игры
function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.gameState = 'finished';

  const [player1, player2] = room.players;
  const result = {
    winner: player1.score > player2.score ? player1.playerId : 
            player2.score > player1.score ? player2.playerId : 'draw',
    player1Score: player1.score,
    player2Score: player2.score,
  };

  // Отправляем результаты
  room.players.forEach(player => {
    player.ws.send(JSON.stringify({
      type: 'game_result',
      ...result,
      isWinner: result.winner === player.playerId,
      isDraw: result.winner === 'draw',
    }));
  });

  // Удаляем комнату через 30 секунд
  setTimeout(() => {
    rooms.delete(roomId);
    console.log(`Комната ${roomId} удалена`);
  }, 30000);
}

// Удаление игрока из всех комнат
function removePlayerFromRooms(ws) {
  rooms.forEach((room, roomId) => {
    room.players = room.players.filter(player => player.ws !== ws);
    if (room.players.length === 0) {
      rooms.delete(roomId);
    }
  });
}

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});