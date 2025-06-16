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
      console.log('Получено сообщение:', data); // Логирование
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

function handleMessage(ws, data) {
  switch (data.type) {
    case 'create_room':
      handleCreateRoom(ws, data);
      break;

    case 'join_room':
      handleJoinRoom(ws, data);
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
      type: 'error',
      message: 'Комната не найдена'
    }));
    return;
  }

  if (room.players.length >= 2) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Комната уже заполнена'
    }));
    return;
  }

  room.players.push({ 
    ws, 
    playerId: data.playerId, 
    name: data.playerName, 
    avatar: data.avatar, 
    score: 0 
  });

  console.log(`Игрок ${data.playerName} присоединился. Всего игроков: ${room.players.length}`);

  // Уведомляем всех игроков о подключении
  room.players.forEach((player, index) => {
    const opponentIndex = 1 - index;
    const opponent = room.players[opponentIndex];

    player.ws.send(JSON.stringify({
      type: 'opponent_joined',
      opponent: {
        name: opponent.name,
        avatar: opponent.avatar,
        playerId: opponent.playerId
      }
    }));
  });

  // Если комната заполнена, начинаем игру
  if (room.players.length === 2) {
    startGame(roomId);
  }
}

function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length !== 2) return;

  room.gameState = 'playing';
  const gameDuration = 60; // 60 секунд

  room.players.forEach(player => {
    player.ws.send(JSON.stringify({
      type: 'game_start',
      duration: gameDuration
    }));
  });

  let timeLeft = gameDuration;
  room.timerInterval = setInterval(() => {
    timeLeft--;

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

function handleScoreUpdate(roomId, playerId, score) {
  const room = rooms.get(roomId);
  if (!room || room.gameState !== 'playing') return;

  const player = room.players.find(p => p.playerId === playerId);
  if (!player) return;

  player.score = score;

  // Отправляем обновление счета оппоненту
  room.players.forEach(p => {
    if (p.playerId !== playerId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({
        type: 'opponent_score_update',
        score: score
      }));
    }
  });
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const [player1, player2] = room.players;
  const result = {
    isDraw: player1.score === player2.score,
    player1Score: player1.score,
    player2Score: player2.score
  };

  room.players.forEach(player => {
    const isWinner = !result.isDraw && 
      (player.playerId === player1.playerId ? 
       player1.score > player2.score : 
       player2.score > player1.score);

    player.ws.send(JSON.stringify({
      type: 'game_result',
      isWinner,
      isDraw: result.isDraw,
      player1Score: result.player1Score,
      player2Score: result.player2Score
    }));
  });

  // Удаляем комнату через 30 секунд
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
    } else if (room.gameState === 'playing') {
      // Уведомляем оставшегося игрока о дисконнекте
      const remainingPlayer = room.players[0];
      remainingPlayer.ws.send(JSON.stringify({
        type: 'opponent_disconnected'
      }));
      
      if (room.timerInterval) {
        clearInterval(room.timerInterval);
      }
      rooms.delete(roomId);
    }
  });
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
