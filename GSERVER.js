// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const http = require('http');
const path = require('path');
const cors = require('cors'); // Add this line

// Модели данных
const Player = require('./models/Player');
const Clan = require('./models/Clan');
const Battle = require('./models/Battle');
const LeaderboardEntry = require('./models/LeaderboardEntry');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "https://cosatka-clickgame-277.netlify.app", // Your game's URL
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Enable CORS for all routes
app.use(cors({
  origin: "https://cosatka-clickgame-277.netlify.app"
}));

// Проверка загрузки .env
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in .env');
  process.exit(1);
}

// Подключение к MongoDB (без устаревших опций)
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.post('/api/save', async (req, res) => {
  try {
    const { userId, gameData } = req.body;
    
    await Player.findOneAndUpdate(
      { userId },
      { $set: gameData },
      { upsert: true, new: true }
    );
    
    // Обновляем лидерборд
    await updateLeaderboard(userId, gameData.score, gameData.level);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/load/:userId', async (req, res) => {
  try {
    const player = await Player.findOne({ userId: req.params.userId });
    res.json(player || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await LeaderboardEntry.find()
      .sort({ score: -1 })
      .limit(100)
      .lean();
    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io логика
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Таймаут для авторизации (например, 5 секунд)
  const authTimeout = setTimeout(() => {
    if (!socket.userId) {
      console.log(`Socket ${socket.id} failed to authenticate in time`);
      socket.disconnect(true);
    }
  }, 5000);

  socket.on('authenticate', async ({ userId, username, authToken }) => {
    try {
      // 1. Валидация входных данных
      if (!userId || !username || !authToken) {
        throw new Error('Missing authentication data');
      }

      // 2. Проверка токена (в реальном приложении)
      // const isValid = await verifyAuthToken(userId, authToken);
      // if (!isValid) throw new Error('Invalid token');

      // 3. Сохранение данных сокета
      socket.userId = userId;
      socket.username = username;
      clearTimeout(authTimeout);

      // 4. Обновление информации игрока в базе
      await Player.findOneAndUpdate(
        { userId },
        { 
          $set: { 
            username, 
            lastOnline: new Date(),
            isOnline: true,
            socketId: socket.id
          }
        },
        { upsert: true, new: true }
      );

      console.log(`User authenticated: ${username} (${userId})`);
      
      // 5. Отправка подтверждения клиенту
      socket.emit('authenticated', { 
        success: true,
        userId,
        username
      });

    } catch (err) {
      console.error('Authentication error:', err.message);
      socket.emit('authentication_failed', { 
        error: err.message || 'Authentication failed'
      });
      socket.disconnect(true);
    }
  });

  // Чат
  socket.on('chat message', async (msg) => {
    try {
      // 1. Проверка авторизации
      if (!socket.userId || !socket.username) {
        throw new Error('Not authenticated');
      }

      // 2. Валидация сообщения
      if (typeof msg !== 'string' || msg.length > 200 || msg.trim().length === 0) {
        throw new Error('Invalid message');
      }

      // 3. Проверка частоты сообщений (антиспам)
      const lastMessage = await ChatMessage.findOne({ userId: socket.userId })
        .sort({ timestamp: -1 })
        .limit(1);

      if (lastMessage && Date.now() - lastMessage.timestamp < 3000) {
        throw new Error('Message rate limit exceeded');
      }

      // 4. Сохранение сообщения в БД
      const message = new ChatMessage({
        userId: socket.userId,
        username: socket.username,
        text: msg.trim(),
        timestamp: Date.now()
      });

      await message.save();

      // 5. Трансляция сообщения
      const messageData = {
        sender: socket.username,
        senderId: socket.userId,
        text: msg.trim(),
        timestamp: Date.now()
      };

      io.emit('chat message', messageData);

    } catch (err) {
      console.error('Chat error:', err.message);
      socket.emit('chat_error', { error: err.message });
    }
  });

  // Баттлы
  socket.on('request_battle', async (mode, callback) => {
    try {
      if (!socket.userId) throw new Error('Not authenticated');
      
      // 1. Проверка, что игрок не в другом баттле
      const existingBattle = await Battle.findOne({
        'players.userId': socket.userId,
        status: { $in: ['waiting', 'active'] }
      });

      if (existingBattle) {
        throw new Error('You are already in a battle');
      }

      // 2. Обработка разных режимов
      if (mode === 'random') {
        const battle = await findRandomOpponent(socket);
        callback({ success: true, battleId: battle._id });
      } 
      // ... другие режимы

    } catch (err) {
      console.error('Battle request error:', err.message);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('battle_click', async (battleId) => {
    try {
      if (!socket.userId) return;

      // 1. Атомарное обновление счета в MongoDB
      const battle = await Battle.findOneAndUpdate(
        { 
          _id: battleId,
          'players.userId': socket.userId,
          status: 'active'
        },
        { $inc: { 'players.$.score': 1 } },
        { new: true }
      );

      if (!battle) return;

      // 2. Расчет CPS (кликов в секунду)
      const now = Date.now();
      const player = battle.players.find(p => p.userId === socket.userId);
      
      if (!player.lastClicks) player.lastClicks = [];
      player.lastClicks = player.lastClicks.filter(t => now - t < 1000);
      player.lastClicks.push(now);
      player.cps = player.lastClicks.length;

      // 3. Сохранение и трансляция обновления
      await battle.save();
      io.to(battleId).emit('battle_update', battle);

    } catch (err) {
      console.error('Battle click error:', err);
    }
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    try {
      // 1. Обновление статуса игрока
      if (socket.userId) {
        await Player.updateOne(
          { userId: socket.userId },
          { $set: { isOnline: false, lastOnline: new Date() } }
        );
      }

      // 2. Обработка активных баттлов
      const activeBattles = await Battle.find({
        'players.userId': socket.userId,
        status: { $in: ['waiting', 'active'] }
      });

      for (const battle of activeBattles) {
        await endBattle(battle._id, 'player_disconnected');
      }

    } catch (err) {
      console.error('Disconnect handler error:', err);
    }
  });
});

// Улучшенная функция поиска противника
async function findRandomOpponent(socket) {
  // 1. Поиск доступного баттла
  const availableBattle = await Battle.findOneAndUpdate(
    {
      mode: 'random',
      status: 'waiting',
      'players.0': { $exists: true },
      'players.1': { $exists: false },
      'players.userId': { $ne: socket.userId } // Исключаем себя
    },
    {
      $push: {
        players: {
          userId: socket.userId,
          username: socket.username,
          score: 0,
          cps: 0,
          lastClicks: []
        }
      },
      $set: { status: 'starting' }
    },
    { new: true }
  );

  if (availableBattle) {
    // 2. Присоединение к существующему баттлу
    socket.join(availableBattle._id);
    io.to(availableBattle._id).emit('battle_found', availableBattle);
    
    // 3. Запуск таймера начала
    setTimeout(() => startBattle(availableBattle._id), 3000);
    return availableBattle;
  }

  // 4. Создание нового баттла
  const newBattle = new Battle({
    mode: 'random',
    status: 'waiting',
    players: [{
      userId: socket.userId,
      username: socket.username,
      score: 0,
      cps: 0,
      lastClicks: []
    }]
  });

  await newBattle.save();
  socket.join(newBattle._id);

  // 5. Таймаут ожидания противника
  setTimeout(async () => {
    const battle = await Battle.findById(newBattle._id);
    if (battle && battle.status === 'waiting') {
      await Battle.findByIdAndDelete(battle._id);
      io.to(battle._id).emit('battle_cancelled');
    }
  }, 15000);

  return newBattle;
}

function joinBattle(battleId, socket) {
  const battle = db.battles[battleId];
  battle.players[socket.userId] = {
    id: socket.userId,
    name: socket.username,
    score: 0,
    cps: 0,
  };
  battle.status = 'starting';

  socket.join(battleId);
  io.to(battleId).emit('battle found', {
    battleId,
    status: 'starting',
    players: battle.players,
  });

  // Начать баттл через 3 секунды
  setTimeout(() => startBattle(battleId), 3000);
}

function startBattle(battleId) {
  const battle = db.battles[battleId];
  battle.status = 'active';
  battle.startTime = Date.now();

  io.to(battleId).emit('battle start', {
    duration: battle.duration,
  });

  // Таймер баттла
  const battleInterval = setInterval(() => {
    const timeLeft = battle.startTime + battle.duration - Date.now();
    if (timeLeft <= 0) {
      clearInterval(battleInterval);
      endBattle(battleId);
    } else {
      // Обновить CPS (кликов в секунду)
      for (const playerId in battle.players) {
        battle.players[playerId].cps = Math.floor(
          Math.random() * 5 + 3
        ); // В реальной игре считаем реальные клики
      }
      io.to(battleId).emit('battle update', battle);
    }
  }, 1000);
}

function endBattle(battleId, reason) {
  const battle = db.battles[battleId];
  if (!battle) return;

  // Определить победителя
  let winner = null;
  const players = Object.values(battle.players);
  if (players.length === 2) {
    if (players[0].score > players[1].score) {
      winner = players[0].id;
    } else if (players[0].score < players[1].score) {
      winner = players[1].id;
    }
  }

  const result = {
    battleId,
    winner,
    scores: {
      [players[0].id]: players[0].score,
      [players[1]?.id]: players[1]?.score,
    },
    reason,
  };

  io.to(battleId).emit('battle end', result);
  delete db.battles[battleId];
}

async function updateLeaderboard(userId, score, level) {
  await LeaderboardEntry.findOneAndUpdate(
    { userId },
    { $set: { score, level, updatedAt: new Date() }},
    { upsert: true }
  );
}

server.listen(10000, () => {
  console.log(`Server running on port 10000`);
});
