// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Игровые данные
const rooms = new Map(); // Все комнаты
const players = new Map(); // Все подключенные игроки
const leaderboard = []; // Таблица лидеров

// Генерация случайного ID
function generateId(length = 6) {
  return Math.random().toString(36).substring(2, length + 2).toUpperCase();
}

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
  let player = {
    ws,
    id: null,
    name: null,
    roomId: null,
    score: 0,
    cps: 0,
    ready: false,
    lastClickTime: Date.now(),
    clickCount: 0
  };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(data, player);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    if (player.id) {
      players.delete(player.id);
      // Удаляем игрока из комнаты, если он был в одной
      if (player.roomId) {
        const room = rooms.get(player.roomId);
        if (room) {
          if (room.player1 === player.id) {
            room.player1 = null;
            // Уведомляем второго игрока, если он есть
            if (room.player2) {
              const opponent = players.get(room.player2);
              if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
                opponent.ws.send(JSON.stringify({
                  type: 'opponent_left'
                }));
              }
            }
          } else if (room.player2 === player.id) {
            room.player2 = null;
            // Уведомляем первого игрока, если он есть
            if (room.player1) {
              const opponent = players.get(room.player1);
              if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
                opponent.ws.send(JSON.stringify({
                  type: 'opponent_left'
                }));
              }
            }
          }
          
          // Если комната пустая, удаляем её
          if (!room.player1 && !room.player2) {
            rooms.delete(player.roomId);
          }
        }
      }
    }
  });
});

function handleMessage(data, player) {
  switch (data.type) {
    case 'register':
      // Регистрация игрока
      player.id = generateId();
      player.name = data.username;
      player.score = data.score || 0;
      player.level = data.level || 1;
      players.set(player.id, player);
      
      player.ws.send(JSON.stringify({
        type: 'registered',
        playerId: player.id
      }));
      break;
      
    case 'create_room':
      // Создание комнаты
      if (player.roomId) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Вы уже находитесь в комнате'
        }));
        return;
      }
      
      const roomId = generateId(4);
      const room = {
        id: roomId,
        player1: player.id,
        player2: null,
        chat: [],
        battleStarted: false,
        battleTime: 30,
        battleTimer: null
      };
      
      rooms.set(roomId, room);
      player.roomId = roomId;
      
      player.ws.send(JSON.stringify({
        type: 'room_created',
        roomId,
        chat: room.chat
      }));
      break;
      
    case 'join_room':
      // Присоединение к комнате
      if (player.roomId) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Вы уже находитесь в комнате'
        }));
        return;
      }
      
      const roomToJoin = rooms.get(data.roomId);
      if (!roomToJoin) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Комната не найдена'
        }));
        return;
      }
      
      if (roomToJoin.player2) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Комната уже заполнена'
        }));
        return;
      }
      
      roomToJoin.player2 = player.id;
      player.roomId = data.roomId;
      
      // Уведомляем обоих игроков
      const player1 = players.get(roomToJoin.player1);
      if (player1 && player1.ws.readyState === WebSocket.OPEN) {
        player1.ws.send(JSON.stringify({
          type: 'opponent_joined',
          opponentName: player.name,
          chat: roomToJoin.chat
        }));
      }
      
      player.ws.send(JSON.stringify({
        type: 'room_joined',
        roomId: data.roomId,
        opponentName: player1.name,
        chat: roomToJoin.chat,
        isPlayer1: false // Добавляем флаг, что это второй игрок
      }));
      break;
      
    case 'send_chat':
      // Отправка сообщения в чат комнаты
      if (!player.roomId) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Вы не в комнате'
        }));
        return;
      }
      
      const currentRoom = rooms.get(player.roomId);
      if (!currentRoom) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Комната не найдена'
        }));
        return;
      }
      
      const chatMessage = {
        sender: player.name,
        text: data.message,
        time: new Date().toLocaleTimeString()
      };
      
      currentRoom.chat.push(chatMessage);
      
      // Отправляем сообщение всем в комнате
      const opponentId = currentRoom.player1 === player.id ? currentRoom.player2 : currentRoom.player1;
      if (opponentId) {
        const opponent = players.get(opponentId);
        if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
          opponent.ws.send(JSON.stringify({
            type: 'chat_message',
            message: chatMessage
          }));
        }
      }
      
      player.ws.send(JSON.stringify({
        type: 'chat_message',
        message: chatMessage
      }));
      break;
      
    case 'start_battle':
      // Начало баттла
      if (!player.roomId) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Вы не в комнате'
        }));
        return;
      }
      
      const battleRoom = rooms.get(player.roomId);
      if (!battleRoom) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Комната не найдена'
        }));
        return;
      }
      
      if (battleRoom.battleStarted) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Баттл уже начат'
        }));
        return;
      }
      
      // Проверяем, что оба игрока готовы
      player.ready = true;
      
      const player1Ready = players.get(battleRoom.player1)?.ready;
      const player2Ready = players.get(battleRoom.player2)?.ready;
      
      if (battleRoom.player1 && battleRoom.player2 && player1Ready && player2Ready) {
        startBattle(battleRoom);
      } else {
        // Уведомляем второго игрока, что первый готов
        const opponentId = battleRoom.player1 === player.id ? battleRoom.player2 : battleRoom.player1;
        if (opponentId) {
          const opponent = players.get(opponentId);
          if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(JSON.stringify({
              type: 'opponent_ready'
            }));
          }
        }
      }
      break;
      
    case 'battle_click':
      // Обработка кликов в баттле
      if (!player.roomId) return;
      
      const clickRoom = rooms.get(player.roomId);
      if (!clickRoom || !clickRoom.battleStarted) return;
      
      player.score += data.value || 1;
      player.clickCount++;
      
      // Обновляем CPS (кликов в секунду)
      const now = Date.now();
      if (now - player.lastClickTime >= 1000) {
        player.cps = player.clickCount / ((now - player.lastClickTime) / 1000);
        player.clickCount = 0;
        player.lastClickTime = now;
        
        // Отправляем обновление сопернику
        const opponentId = clickRoom.player1 === player.id ? clickRoom.player2 : clickRoom.player1;
        if (opponentId) {
          const opponent = players.get(opponentId);
          if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(JSON.stringify({
              type: 'battle_update',
              opponentScore: player.score,
              opponentCps: player.cps
            }));
          }
        }
      }
      
      // Обновляем прогресс для текущего игрока
      const opponent = players.get(clickRoom.player1 === player.id ? clickRoom.player2 : clickRoom.player1);
      const totalScore = player.score + (opponent?.score || 0);
      const playerPercent = totalScore > 0 ? (player.score / totalScore) * 100 : 50;
      
      player.ws.send(JSON.stringify({
        type: 'battle_progress',
        progress: playerPercent
      }));
      break;
      
    case 'submit_score':
      // Отправка результата в таблицу лидеров
      leaderboard.push({
        name: data.name,
        score: data.score,
        level: data.level,
        date: new Date().toISOString()
      });
      
      // Сортируем по убыванию очков и оставляем топ-100
      leaderboard.sort((a, b) => b.score - a.score);
      if (leaderboard.length > 100) {
        leaderboard.length = 100;
      }
      break;
  }
}

function startBattle(room) {
  room.battleStarted = true;
  room.battleTimer = room.battleTime;
  
  // Уведомляем игроков о начале баттла
  const player1 = players.get(room.player1);
  const player2 = players.get(room.player2);
  
  if (player1 && player1.ws.readyState === WebSocket.OPEN) {
    player1.ws.send(JSON.stringify({
      type: 'battle_start',
      opponentName: player2?.name || 'Соперник',
      battleTime: room.battleTime
    }));
  }
  
  if (player2 && player2.ws.readyState === WebSocket.OPEN) {
    player2.ws.send(JSON.stringify({
      type: 'battle_start',
      opponentName: player1?.name || 'Соперник',
      battleTime: room.battleTime
    }));
  }
  
  // Запускаем таймер баттла
  const timer = setInterval(() => {
    room.battleTimer--;
    
    // Отправляем обновление времени обоим игрокам
    if (player1 && player1.ws.readyState === WebSocket.OPEN) {
      player1.ws.send(JSON.stringify({
        type: 'battle_timer',
        timeLeft: room.battleTimer
      }));
    }
    
    if (player2 && player2.ws.readyState === WebSocket.OPEN) {
      player2.ws.send(JSON.stringify({
        type: 'battle_timer',
        timeLeft: room.battleTimer
      }));
    }
    
    // Завершаем баттл, когда время вышло
    if (room.battleTimer <= 0) {
      clearInterval(timer);
      endBattle(room);
    }
  }, 1000);
}

function endBattle(room) {
  const player1 = players.get(room.player1);
  const player2 = players.get(room.player2);
  
  let winner = null;
  let reward = 0;
  
  if (player1 && player2) {
    if (player1.score > player2.score) {
      winner = player1.id;
      reward = Math.floor(player2.score * 0.2); // 20% от очков соперника
      player1.score += reward;
    } else if (player2.score > player1.score) {
      winner = player2.id;
      reward = Math.floor(player1.score * 0.2);
      player2.score += reward;
    }
    // Если ничья, reward остается 0
  }
  
  // Отправляем результаты игрокам
  if (player1 && player1.ws.readyState === WebSocket.OPEN) {
    player1.ws.send(JSON.stringify({
      type: 'battle_end',
      winner: winner === player1.id ? 'you' : winner === player2.id ? 'opponent' : 'draw',
      reward: winner === player1.id ? reward : 0,
      yourScore: player1.score,
      opponentScore: player2?.score || 0
    }));
  }
  
  if (player2 && player2.ws.readyState === WebSocket.OPEN) {
    player2.ws.send(JSON.stringify({
      type: 'battle_end',
      winner: winner === player2.id ? 'you' : winner === player1.id ? 'opponent' : 'draw',
      reward: winner === player2.id ? reward : 0,
      yourScore: player2.score,
      opponentScore: player1?.score || 0
    }));
  }
  
  // Сбрасываем состояние комнаты
  room.battleStarted = false;
  room.battleTimer = room.battleTime;
  if (player1) player1.score = 0;
  if (player2) player2.score = 0;
}

// API для получения таблицы лидеров
app.get('/api/leaderboard', (req, res) => {
  res.json(leaderboard.slice(0, 50)); // Возвращаем топ-50
});

// API для отправки результата
app.post('/api/submit-score', (req, res) => {
  const { name, score, level } = req.body;
  if (!name || !score || !level) {
    return res.status(400).json({ error: 'Необходимы name, score и level' });
  }
  
  leaderboard.push({
    name,
    score,
    level,
    date: new Date().toISOString()
  });
  
  // Сортируем по убыванию очков и оставляем топ-100
  leaderboard.sort((a, b) => b.score - a.score);
  if (leaderboard.length > 100) {
    leaderboard.length = 100;
  }
  
  res.json({ success: true });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});