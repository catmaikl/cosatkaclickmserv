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

// Проверка подключения к БД
pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('Ошибка подключения к PostgreSQL:', err);
  } else {
    console.log('Успешное подключение к PostgreSQL');
    initializeDatabase();
  }
});

// Инициализация таблиц
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        level INTEGER NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Таблица leaderboard готова');
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  }
}

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

// WebSocket сервер
const wss = new WebSocket.Server({ noServer: true });
const rooms = new Map();

wss.on('connection', (ws, request) => {
  // Обработка WebSocket соединений
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (err) {
      console.error('Ошибка обработки WebSocket сообщения:', err);
    }
  });
});

function handleWebSocketMessage(ws, data) {
    switch(data.type) {
      case 'create_room':
        const roomId = generateRoomId();
        rooms.set(roomId, {
          players: [{
            ws,
            playerId: data.playerId,
            name: data.playerName,
            avatar: data.avatar,
            score: 0
          }],
          gameState: 'waiting'
        });
        ws.send(JSON.stringify({
          type: 'room_created',
          roomId
        }));
        break;

      case 'join_room':
        const room = rooms.get(data.roomId);
        if (room && room.players.length < 2) {
          room.players.push({
            ws,
            playerId: data.playerId,
            name: data.playerName,
            avatar: data.avatar,
            score: 0
          });
          
          // Уведомляем обоих игроков
          room.players.forEach(player => {
            player.ws.send(JSON.stringify({
              type: 'player_joined',
              player: {
                name: data.playerName,
                avatar: data.avatar
              }
            }));
          });
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Комната заполнена или не существует'
          }));
        }
        break;

      case 'game_start':
        if (room && room.players.length === 2) {
          // Устанавливаем состояние игры "в процессе"
          room.gameState = 'playing';
          
          // Запускаем таймер игры (60 секунд)
          room.timer = 60;
          room.gameInterval = setInterval(() => {
            room.timer--;
            
            // Отправляем обновление таймера обоим игрокам
            room.players.forEach(player => {
              player.ws.send(JSON.stringify({
                type: 'timer_update',
                timer: room.timer
              }));
            });

            // Завершаем игру, когда время вышло
            if (room.timer <= 0) {
              clearInterval(room.gameInterval);
              endGame(room);
            }
          }, 1000);

          // Уведомляем игроков о начале игры
          room.players.forEach(player => {
            player.ws.send(JSON.stringify({
              type: 'game_started',
              opponentName: room.players.find(p => p.playerId !== player.playerId).name,
              opponentAvatar: room.players.find(p => p.playerId !== player.playerId).avatar
            }));
          });
        }
        break;

      case 'score_update':
        const updateRoom = rooms.get(data.roomId);
        if (updateRoom && updateRoom.gameState === 'playing') {
          // Находим игрока и обновляем его счет
          const player = updateRoom.players.find(p => p.playerId === data.playerId);
          if (player) {
            player.score = data.score;
            
            // Отправляем обновление счета противнику
            const opponent = updateRoom.players.find(p => p.playerId !== data.playerId);
            if (opponent) {
              opponent.ws.send(JSON.stringify({
                type: 'opponent_score_update',
                score: data.score
              }));
            }
          }
        }
        break;
    }
}

function endGame(room) {
  room.gameState = 'finished';
  
  const player1 = room.players[0];
  const player2 = room.players[1];
  
  // Определяем победителя
  let result;
  if (player1.score > player2.score) {
    result = {
      winner: player1.playerId,
      player1Score: player1.score,
      player2Score: player2.score
    };
  } else if (player2.score > player1.score) {
    result = {
      winner: player2.playerId,
      player1Score: player1.score,
      player2Score: player2.score
    };
  } else {
    result = {
      winner: 'draw',
      player1Score: player1.score,
      player2Score: player2.score
    };
  }

  // Отправляем результаты обоим игрокам
  room.players.forEach(player => {
    player.ws.send(JSON.stringify({
      type: 'game_result',
      ...result,
      isWinner: result.winner === player.playerId,
      isDraw: result.winner === 'draw'
    }));
  });

  // Очищаем интервал и удаляем комнату через некоторое время
  clearInterval(room.gameInterval);
  setTimeout(() => {
    rooms.delete(room.roomId);
  }, 30000); // Удаляем комнату через 30 секунд после окончания
}

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