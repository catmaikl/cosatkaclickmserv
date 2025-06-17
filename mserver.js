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

  // Отправка ping каждые 30 секунд
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      console.error('Ошибка парсинга сообщения:', err);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log('Клиент отключился');
    removePlayerFromRooms(ws);
  });
});

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
    gameState: 'waiting',
  });

  ws.send(JSON.stringify({
    type: 'room_created',
    roomId,
  }));

  console.log(`Комната ${roomId} создана`);
}

function handleJoinRoom(ws, data) {
  const room = rooms.get(data.roomId);
  if (!room) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Комната не найдена"
    }));
    return;
  }

  if (room.players.length >= 2) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Комната уже заполнена"
    }));
    return;
  }

  const newPlayer = {
    ws,
    playerId: data.playerId,
    name: data.playerName,
    avatar: data.avatar,
    score: 0
  };
  room.players.push(newPlayer);

  console.log(`Игрок ${data.playerName} присоединился. Всего игроков: ${room.players.length}`);

  // Уведомляем первого игрока о подключении второго
  if (room.players.length === 2) {
    room.players[0].ws.send(JSON.stringify({
      type: "opponent_joined",
      opponent: {
        name: newPlayer.name,
        avatar: newPlayer.avatar,
        playerId: newPlayer.playerId
      }
    }));

    room.players[1].ws.send(JSON.stringify({
      type: "opponent_joined",
      opponent: {
        name: room.players[0].name,
        avatar: room.players[0].avatar,
        playerId: room.players[0].playerId
      }
    }));

    // Запускаем игру через 3 секунды
    setTimeout(() => handleStartGame(data.roomId), 3000);
  }
}

function handleStartGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length !== 2) return;

  room.gameState = 'playing';
  room.startTime = Date.now();

  room.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({
        type: 'game_start',
        duration: 60
      }));
    }
  });

  let timeLeft = 60;
  room.timerInterval = setInterval(() => {
    timeLeft--;

    room.players.forEach(player => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
          type: 'timer_update',
          timeLeft: timeLeft
        }));
      }
    });

    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      endGame(roomId);
    }
  }, 1000);
}


function handleScoreUpdate(roomId, playerId, score) {
  const room = rooms.get(roomId);
  if (!room || room.gameState !== 'playing') return;

  const player = room.players.find(p => p.playerId === playerId);
  if (!player) return;

  player.score = score;

  // Отправляем обновление обоим игрокам
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({
        type: 'score_update',
        playerId: playerId,
        score: score
      }));
    }
  });
}

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

  room.players.forEach(player => {
    player.ws.send(JSON.stringify({
      type: 'game_result',
      ...result,
      isWinner: result.winner === player.playerId,
      isDraw: result.winner === 'draw',
    }));
  });

  setTimeout(() => {
    rooms.delete(roomId);
    console.log(`Комната ${roomId} удалена`);
  }, 30000);
}

function removePlayerFromRooms(ws) {
  rooms.forEach((room, roomId) => {
    room.players = room.players.filter(player => player.ws !== ws);
    if (room.players.length === 0) {
      rooms.delete(roomId);
    } else if (room.players.length === 1 && room.gameState === 'playing') {
      // Если один игрок отключился во время игры
      const remainingPlayer = room.players[0];
      remainingPlayer.ws.send(JSON.stringify({
        type: 'game_result',
        isWinner: true,
        isDraw: false,
        player1Score: remainingPlayer.score,
        player2Score: 0
      }));

      if (room.timerInterval) {
        clearInterval(room.timerInterval);
      }
      rooms.delete(roomId);
    }
  });
}

setInterval(() => {
  console.log('Keep-alive');
}, 300000); // Каждые 5 минут

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => { // Слушаем все интерфейсы
  console.log(`Сервер запущен на порту ${PORT}`);
});
