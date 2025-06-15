const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

wss.on('connection', (ws) => {
  console.log('Новое подключение');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      console.error('Ошибка парсинга сообщения:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Некорректный формат сообщения'
      }));
    }
  });

  ws.on('close', () => {
    console.log('Клиент отключился');
    removePlayerFromRooms(ws);
  });
});

function handleMessage(ws, data) {
  if (!data.type) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Отсутствует тип сообщения'
    }));
    return;
  }

  switch (data.type) {
    case 'create_room':
      handleCreateRoom(ws, data);
      break;

    case 'join_room':
      handleJoinRoom(ws, data);
      break;

    case 'game_start':
      handleStartGame(data.roomId);
      break;

    case 'score_update':
      handleScoreUpdate(data.roomId, data.playerId, data.score);
      break;

    case 'rematch_request':
      handleRematchRequest(data.roomId, data.playerId);
      break;

    default:
      console.warn('Неизвестный тип сообщения:', data.type);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Неизвестный тип сообщения'
      }));
  }
}

function handleCreateRoom(ws, data) {
  const roomId = generateRoomId();
  const player = {
    ws,
    playerId: data.playerId,
    name: data.playerName || 'Игрок',
    avatar: data.avatar || 'cat.png',
    score: 0,
    readyForRematch: false
  };

  rooms.set(roomId, {
    players: [player],
    gameState: 'waiting',
    timerInterval: null
  });

  ws.send(JSON.stringify({
    type: 'room_created',
    roomId,
    playerId: data.playerId
  }));

  console.log(`Комната ${roomId} создана игроком ${player.name}`);
}

function handleJoinRoom(ws, data) {
  const room = rooms.get(data.roomId);

  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Комната не найдена'
    }));
    return;
  }

  if (room.players.length >= 2) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Комната заполнена'
    }));
    return;
  }

  const player = {
    ws,
    playerId: data.playerId,
    name: data.playerName || 'Игрок',
    avatar: data.avatar || 'cat.png',
    score: 0,
    readyForRematch: false
  };

  room.players.push(player);

  // Уведомляем обоих игроков
  room.players.forEach(p => {
    const opponent = room.players.find(op => op.playerId !== p.playerId);
    p.ws.send(JSON.stringify({
      type: 'player_joined',
      opponent: {
        name: opponent.name,
        avatar: opponent.avatar
      },
      roomId: data.roomId
    }));
  });

  console.log(`Игрок ${player.name} присоединился к комнате ${data.roomId}`);
}

function handleStartGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length !== 2 || room.gameState !== 'waiting') return;

  room.gameState = 'playing';
  room.players.forEach(p => p.score = 0);

  // Таймер игры (60 секунд)
  let timeLeft = 60;
  room.timerInterval = setInterval(() => {
    timeLeft--;

    room.players.forEach(player => {
      player.ws.send(JSON.stringify({
        type: 'timer_update',
        timeLeft
      }));
    });

    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      endGame(roomId);
    }
  }, 1000);

  // Уведомляем игроков о начале игры
  room.players.forEach(player => {
    player.ws.send(JSON.stringify({
      type: 'game_start',
      timeLeft: 60
    }));
  });

  console.log(`Игра началась в комнате ${roomId}`);
}

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
      type: 'score_update',
      playerId,
      score
    }));
  }
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.gameState = 'finished';
  if (room.timerInterval) clearInterval(room.timerInterval);

  const [player1, player2] = room.players;
  const result = {
    winner: player1.score > player2.score ? player1.playerId : 
            player2.score > player1.score ? player2.playerId : 'draw',
    player1Score: player1.score,
    player2Score: player2.score,
  };

  // Отправляем результаты
  room.players.forEach(player => {
    const isWinner = result.winner === player.playerId;
    const isDraw = result.winner === 'draw';
    
    player.ws.send(JSON.stringify({
      type: 'game_result',
      winner: result.winner,
      player1Score: result.player1Score,
      player2Score: result.player2Score,
      isWinner,
      isDraw
    }));
  });

  console.log(`Игра завершена в комнате ${roomId}. Победитель: ${result.winner}`);
}

function handleRematchRequest(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room || room.gameState !== 'finished') return;

  const player = room.players.find(p => p.playerId === playerId);
  if (!player) return;

  player.readyForRematch = true;

  // Проверяем, готовы ли оба игрока к реваншу
  if (room.players.every(p => p.readyForRematch)) {
    room.gameState = 'waiting';
    room.players.forEach(p => {
      p.readyForRematch = false;
      p.score = 0;
      p.ws.send(JSON.stringify({
        type: 'rematch_accepted'
      }));
    });
    console.log(`Реванш в комнате ${roomId}`);
  } else {
    // Уведомляем другого игрока о запросе реванша
    const opponent = room.players.find(p => p.playerId !== playerId);
    if (opponent) {
      opponent.ws.send(JSON.stringify({
        type: 'rematch_requested'
      }));
    }
  }
}

function removePlayerFromRooms(ws) {
  rooms.forEach((room, roomId) => {
    const disconnectedPlayer = room.players.find(p => p.ws === ws);
    if (disconnectedPlayer) {
      console.log(`Игрок ${disconnectedPlayer.name} отключился от комнаты ${roomId}`);
      
      // Уведомляем другого игрока об отключении
      const opponent = room.players.find(p => p.ws !== ws);
      if (opponent) {
        opponent.ws.send(JSON.stringify({
          type: 'opponent_disconnected'
        }));
      }
      
      // Очищаем интервал таймера, если есть
      if (room.timerInterval) clearInterval(room.timerInterval);
      
      // Удаляем комнату
      rooms.delete(roomId);
    }
  });
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
