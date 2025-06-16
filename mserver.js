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

    case 'start_game':
      handleStartGame(data.roomId);
      break;

    case 'opponent_score_update':
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
  if (!room) return;

  room.players.push({ ws, playerId: data.playerId, name: data.playerName, avatar: data.avatar, score: 0 });

  console.log(`Игрок ${data.playerName} присоединился. Всего игроков: ${room.players.length}`);

  // Отправляем данные об оппоненте каждому игроку
  room.players.forEach((player, index) => {
    const opponentIndex = 1 - index; // Индекс оппонента (0 или 1)
    const opponent = room.players[opponentIndex];

    player.ws.send(JSON.stringify({
      type: "join_room", // Тип сообщения, который ждёт клиент
      opponent: {
        name: opponent.name,
        avatar: opponent.avatar,
        playerId: opponent.playerId
      },
    }));
  });

  // Если комната заполнена (2 игрока), запускаем игру
  if (room.players.length === 2) {
    console.log(`Комната ${data.roomId} заполнена, запускаем игру...`);
    handleStartGame(data.roomId);
  }
}

function handleStartGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length !== 2) return;

  room.gameState = 'playing';

  const playersData = room.players.map(player => ({
    playerId: player.playerId,
    name: player.name,
    avatar: player.avatar,
    score: player.score
  }));

  room.players.forEach((player, index) => {
    const opponentIndex = 1 - index;
    player.ws.send(JSON.stringify({
    type: 'game_start',
    opponent: {
      name: playersData[opponentIndex].name,
      avatar: playersData[opponentIndex].avatar,
      playerId: playersData[opponentIndex].playerId
    },
    duration: 60,
    startTime: Date.now()
  }));
  });

  let timeLeft = 60;
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
    console.log(`[SCORE_UPDATE] Room: ${roomId}, Player: ${playerId}, Score: ${score}`);
    
    const room = rooms.get(roomId);
    if (!room) {
        console.error(`Room ${roomId} not found`);
        return;
    }

    if (room.gameState !== 'playing') {
        console.error(`Game in room ${roomId} is not in playing state`);
        return;
    }

    // Обновляем счет игрока
    const player = room.players.find(p => p.playerId === playerId);
    if (!player) {
        console.error(`Player ${playerId} not found in room ${roomId}`);
        return;
    }
    player.score = score;

    // Отправляем обновление ВСЕМ другим игрокам в комнате
    room.players.forEach(opponent => {
        if (opponent.playerId !== playerId) {
            console.log(`Sending update to opponent ${opponent.playerId}`);
            try {
                opponent.ws.send(JSON.stringify({
                    type: 'opponent_score_update',
                    playerId: playerId,
                    score: score,
                    roomId: roomId
                }));
            } catch (e) {
                console.error(`Error sending to ${opponent.playerId}:`, e);
            }
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

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
