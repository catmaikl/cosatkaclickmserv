const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Хранилище данных
const rooms = new Map(); // roomId -> { players, gameState }
const players = new Map(); // playerId -> { ws, roomId }

// Обработка подключений
wss.on('connection', (ws) => {
  const playerId = uuid.v4();
  players.set(playerId, { ws, roomId: null });

  console.log(`Новое подключение: ${playerId}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(playerId, data);
    } catch (e) {
      console.error('Ошибка обработки сообщения:', e);
      sendError(ws, 'Неверный формат сообщения');
    }
  });

  ws.on('close', () => {
    const player = players.get(playerId);
    if (player && player.roomId) {
      handleDisconnect(playerId, player.roomId);
    }
    players.delete(playerId);
    console.log(`Отключение: ${playerId}`);
  });
});

// Обработчик сообщений
function handleMessage(playerId, data) {
  const player = players.get(playerId);
  if (!player) return;

  switch (data.type) {
    case 'create_room':
      createRoom(playerId, data);
      break;
    case 'join_room':
      joinRoom(playerId, data);
      break;
    case 'game_start':
      startGame(playerId, data.roomId);
      break;
    case 'score_update':
      updateScore(playerId, data.roomId, data.score);
      break;
    default:
      sendError(player.ws, 'Неизвестный тип сообщения');
  }
}

// Создание комнаты
function createRoom(playerId, data) {
  const roomId = uuid.v4().substr(0, 6).toUpperCase(); // Короткий ID комнаты
  const player = players.get(playerId);

  rooms.set(roomId, {
    players: [{
      id: playerId,
      name: data.playerName,
      avatar: data.avatar,
      score: 0,
      ws: player.ws
    }],
    gameState: 'waiting',
    timer: null
  });

  player.roomId = roomId;

  player.ws.send(JSON.stringify({
    type: 'room_created',
    roomId
  }));

  console.log(`Создана комната ${roomId} игроком ${data.playerName}`);
}

// Подключение к комнате
function joinRoom(playerId, data) {
  const roomId = data.roomId;
  const room = rooms.get(roomId);
  const player = players.get(playerId);

  if (!room) {
    sendError(player.ws, 'Комната не найдена');
    return;
  }

  if (room.players.length >= 2) {
    sendError(player.ws, 'Комната уже заполнена');
    return;
  }

  player.roomId = roomId;
  room.players.push({
    id: playerId,
    name: data.playerName,
    avatar: data.avatar,
    score: 0,
    ws: player.ws
  });

  // Уведомляем всех игроков в комнате
  broadcastToRoom(roomId, {
    type: 'player_joined',
    player: {
      name: data.playerName,
      avatar: data.avatar
    }
  });

  console.log(`Игрок ${data.playerName} присоединился к комнате ${roomId}`);
}

// Начало игры
function startGame(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length < 2) return;

  room.gameState = 'playing';
  broadcastToRoom(roomId, { type: 'game_start' });

  // Таймер игры (60 секунд)
  room.timer = setTimeout(() => {
    endGame(roomId);
  }, 60000);

  console.log(`Игра началась в комнате ${roomId}`);
}

// Обновление счета
function updateScore(playerId, roomId, score) {
  const room = rooms.get(roomId);
  if (!room || room.gameState !== 'playing') return;

  const player = room.players.find(p => p.id === playerId);
  if (player) {
    player.score = score;
  }

  // Отправляем обновление противнику
  const opponent = room.players.find(p => p.id !== playerId);
  if (opponent) {
    opponent.ws.send(JSON.stringify({
      type: 'score_update',
      playerId,
      score
    }));
  }
}

// Завершение игры
function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Определяем победителя
  let winner = 'draw';
  if (room.players[0].score > room.players[1].score) {
    winner = room.players[0].id;
  } else if (room.players[1].score > room.players[0].score) {
    winner = room.players[1].id;
  }

  // Отправляем результаты
  broadcastToRoom(roomId, {
    type: 'game_end',
    winner,
    playerScore: room.players[0].score,
    opponentScore: room.players[1].score
  });

  // Очищаем комнату через 30 секунд
  setTimeout(() => {
    rooms.delete(roomId);
  }, 30000);

  console.log(`Игра завершена в комнате ${roomId}. Победитель: ${winner}`);
}

// Отключение игрока
function handleDisconnect(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Удаляем игрока из комнаты
  room.players = room.players.filter(p => p.id !== playerId);

  // Если игра началась, завершаем ее
  if (room.gameState === 'playing') {
    clearTimeout(room.timer);
    const remainingPlayer = room.players[0];
    if (remainingPlayer) {
      remainingPlayer.ws.send(JSON.stringify({
        type: 'game_end',
        winner: remainingPlayer.id,
        playerScore: remainingPlayer.score,
        opponentScore: 0
      }));
    }
  }

  // Если комната пуста, удаляем ее
  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    // Уведомляем оставшихся игроков
    broadcastToRoom(roomId, {
      type: 'player_left'
    });
  }

  console.log(`Игрок ${playerId} покинул комнату ${roomId}`);
}

// Вспомогательные функции
function broadcastToRoom(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  });
}

function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'error',
      message
    }));
  }
}

// Запуск сервера
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});