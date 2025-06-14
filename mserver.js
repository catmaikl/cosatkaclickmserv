const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const WebSocket = require('ws');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL подключение
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/cosatkadb',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// WebSocket сервер
const wss = new WebSocket.Server({ noServer: true });
const rooms = new Map(); // Хранит все активные комнаты
const connections = new Map(); // Хранит все активные соединения

// Генерация ID комнаты
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Завершение игры
function endGame(room, disconnectedPlayerId = null) {
  clearInterval(room.gameInterval);
  room.gameState = 'finished';

  const [player1, player2] = room.players;
  
  // Если игрок отключился
  if (disconnectedPlayerId) {
    const winner = player1.playerId === disconnectedPlayerId ? player2 : player1;
    
    room.players.forEach(player => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
          type: 'game_result',
          winner: winner.playerId,
          player1Score: player1.score,
          player2Score: player2.score,
          isWinner: player.playerId === winner.playerId,
          isDraw: false,
          disconnect: true
        }));
      }
    });
  } 
  // Если игра завершилась по таймеру
  else {
    const result = player1.score > player2.score ? {
      winner: player1.playerId,
      isDraw: false
    } : player2.score > player1.score ? {
      winner: player2.playerId,
      isDraw: false
    } : {
      winner: 'draw',
      isDraw: true
    };

    room.players.forEach(player => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
          type: 'game_result',
          ...result,
          player1Score: player1.score,
          player2Score: player2.score,
          isWinner: result.winner === player.playerId,
          disconnect: false
        }));
      }
    });
  }

  // Удаляем комнату через 30 секунд
  setTimeout(() => {
    rooms.delete(room.roomId);
  }, 30000);
}

// Обработчик WebSocket сообщений
function handleWebSocketMessage(ws, data) {
  try {
    const message = JSON.parse(data);
    
    switch(message.type) {
      case 'create_room':
        const roomId = generateRoomId();
        rooms.set(roomId, {
          players: [{
            ws,
            playerId: message.playerId,
            name: message.playerName,
            avatar: message.avatar,
            score: 0
          }],
          gameState: 'waiting'
        });
        
        connections.set(message.playerId, { ws, roomId });
        
        ws.send(JSON.stringify({
          type: 'room_created',
          roomId
        }));
        break;

      case 'join_room':
        const room = rooms.get(message.roomId);
        
        if (!room) {
          return ws.send(JSON.stringify({
            type: 'error',
            message: 'Комната не найдена'
          }));
        }
        
        if (room.players.length >= 2) {
          return ws.send(JSON.stringify({
            type: 'error',
            message: 'Комната уже заполнена'
          }));
        }
        
        room.players.push({
          ws,
          playerId: message.playerId,
          name: message.playerName,
          avatar: message.avatar,
          score: 0
        });
        
        connections.set(message.playerId, { ws, roomId: message.roomId });
        
        // Уведомляем обоих игроков
        room.players.forEach(player => {
          player.ws.send(JSON.stringify({
            type: 'player_joined',
            opponent: {
              name: message.playerName,
              avatar: message.avatar
            }
          }));
        });
        break;

      case 'start_game':
        const startRoom = rooms.get(message.roomId);
        if (startRoom && startRoom.players.length === 2) {
          startRoom.gameState = 'playing';
          startRoom.timer = 60; // 60 секунд на игру
          
          startRoom.gameInterval = setInterval(() => {
            startRoom.timer--;
            
            // Отправляем обновление таймера
            startRoom.players.forEach(player => {
              if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify({
                  type: 'timer_update',
                  timer: startRoom.timer
                }));
              }
            });

            // Завершаем игру по таймеру
            if (startRoom.timer <= 0) {
              endGame(startRoom);
            }
          }, 1000);
        }
        break;

      case 'score_update':
        const updateRoom = rooms.get(message.roomId);
        if (updateRoom && updateRoom.gameState === 'playing') {
          const player = updateRoom.players.find(p => p.playerId === message.playerId);
          if (player) {
            player.score = message.score;
            
            // Отправляем обновление противнику
            const opponent = updateRoom.players.find(p => p.playerId !== message.playerId);
            if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
              opponent.ws.send(JSON.stringify({
                type: 'opponent_score_update',
                score: message.score
              }));
            }
          }
        }
        break;

      case 'rematch_request':
        // Логика реванша
        break;

      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Неизвестный тип сообщения'
        }));
    }
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Ошибка сервера'
    }));
  }
}

// Инициализация WebSocket сервера
wss.on('connection', (ws, request) => {
  console.log('Новое соединение установлено');
  
  ws.on('message', (message) => {
    handleWebSocketMessage(ws, message);
  });
  
  ws.on('close', () => {
    console.log('Соединение закрыто');
    
    // Находим игрока в комнате
    for (const [playerId, connection] of connections.entries()) {
      if (connection.ws === ws) {
        const room = rooms.get(connection.roomId);
        
        if (room && room.gameState === 'playing') {
          // Завершаем игру, если игрок отключился во время матча
          endGame(room, playerId);
        }
        
        connections.delete(playerId);
        break;
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket ошибка:', error);
  });
});

// API Endpoints
app.post('/api/submit-score', async (req, res) => {
  try {
    const { name, score, level } = req.body;
    const result = await pool.query(
      'INSERT INTO leaderboard (name, score, level) VALUES ($1, $2, $3) RETURNING *',
      [name, score, level]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Ошибка сохранения счета:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT name, score, level FROM leaderboard ORDER BY score DESC LIMIT 10'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка получения лидерборда:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`HTTP сервер запущен на порту ${PORT}`);
});

// Подключение WebSocket к HTTP серверу
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});