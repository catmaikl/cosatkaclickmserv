// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const http = require('http');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Database models
const Player = require('./models/Player');
const PlayerToken = require('./models/PlayerToken');
const Clan = require('./models/Clan');
const Battle = require('./models/Battle');
const LeaderboardEntry = require('./models/LeaderboardEntry');
const Achievement = require('./models/Achievement');
const ChatMessage = require('./models/ChatMessage');
const GameEvent = require('./models/GameEvent');

const app = express();
const server = http.createServer(app);

// Configure CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://cosatka-clickgame-277.netlify.app",
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: process.env.CLIENT_URL || "https://cosatka-clickgame-277.netlify.app"
}));

mongoose.set('debug', true); // Показывает все запросы в консоль

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  retryWrites: true,
  w: 'majority',
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 30000
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для проверки JWT токена
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Генерация токенов
function generateAccessToken(user) {
  return jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '15m' });
}

function generateRefreshToken(user) {
  return jwt.sign(user, process.env.REFRESH_TOKEN_SECRET);
}

// API для получения токена
app.post('/api/token', async (req, res) => {
  const { userId } = req.body;
  const user = { userId };
  
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  
  // Сохраняем refresh токен в базе
  await PlayerToken.findOneAndUpdate(
    { userId },
    { $set: { token: refreshToken } },
    { upsert: true }
  );
  
  res.json({ accessToken, refreshToken });
});

// API для обновления токена
app.post('/api/token/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.sendStatus(401);
  
  const storedToken = await PlayerToken.findOne({ token: refreshToken });
  if (!storedToken) return res.sendStatus(403);
  
  jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    const accessToken = generateAccessToken({ userId: user.userId });
    res.json({ accessToken });
  });
});

app.post('/api/save', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user;
    const gameData = req.body;
    
    await Player.findOneAndUpdate(
      { userId },
      { $set: gameData },
      { upsert: true }
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API Endpoints
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

app.get('/api/active-event', async (req, res) => {
  try {
    const event = await GameEvent.findOne({ isActive: true });
    res.json(event || { isActive: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Таймаут аутентификации (5 секунд)
  const authTimeout = setTimeout(() => {
    if (!socket.userId) {
      console.log(`Socket ${socket.id} failed to authenticate in time`);
      socket.disconnect(true);
    }
  }, 5000);

  // Обработчик аутентификации
  socket.on('authenticate', async ({ token, userId, username }) => {
    try {
      if (!token || !userId || !username) {
        throw new Error('Требуется токен, userId и username');
      }

      // Верификация токена
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user) => {
        if (err || user.userId !== userId) {
          throw new Error('Неверный токен');
        }
      });

      socket.userId = userId;
      socket.username = username;
      clearTimeout(authTimeout);

      // Обновление статуса игрока
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
      
      // Отправка данных игры клиенту
      const playerData = await Player.findOne({ userId }).lean();
      const achievements = await Achievement.find({ userId }).lean();
      
      socket.emit('authenticated', { 
        success: true,
        gameData: playerData,
        achievements: achievements.reduce((acc, ach) => {
          acc[ach.name] = ach;
          return acc;
        }, {})
      });

    } catch (err) {
      console.error('Authentication error:', err.message);
      socket.emit('authentication_failed', { 
        error: err.message || 'Ошибка аутентификации'
      });
      socket.disconnect(true);
    }
  });

  // Game state updates
  socket.on('update_stats', async (data, callback) => {
    try {
      if (!socket.userId) throw new Error('Not authenticated');

      const update = {
        score: data.score,
        perclick: data.perclick,
        persecond: data.persecond,
        level: data.level,
        totalClicks: data.totalClicks,
        lastActive: new Date()
      };

      await Player.findOneAndUpdate(
        { userId: socket.userId },
        { $set: update },
        { upsert: true }
      );

      // Update leaderboard
      await LeaderboardEntry.findOneAndUpdate(
        { userId: socket.userId },
        { $set: { score: data.score, level: data.level, username: socket.username }},
        { upsert: true }
      );

      callback({ success: true });
    } catch (err) {
      console.error('Stats update error:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Battle system
  socket.on('request_battle', async (mode, callback) => {
    try {
      if (!socket.userId) throw new Error('Not authenticated');
      
      if (mode === 'random') {
        const battle = await findRandomOpponent(socket);
        callback({ success: true, battleId: battle._id });
      } else {
        throw new Error('Invalid battle mode');
      }
    } catch (err) {
      console.error('Battle request error:', err.message);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('battle_click', async (battleId) => {
    try {
      if (!socket.userId) return;

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

      // Calculate CPS
      const now = Date.now();
      const player = battle.players.find(p => p.userId === socket.userId);
      
      player.lastClicks = (player.lastClicks || []).filter(t => now - t < 1000);
      player.lastClicks.push(now);
      player.cps = player.lastClicks.length;

      await battle.save();
      io.to(battleId).emit('battle_update', battle);
    } catch (err) {
      console.error('Battle click error:', err);
    }
  });

  // Chat system
  socket.on('chat_message', async (message, callback) => {
    try {
      if (!socket.userId || !socket.username) throw new Error('Not authenticated');
      if (typeof message !== 'string' || message.length > 200 || message.trim().length === 0) {
        throw new Error('Invalid message');
      }

      // Check message rate limit
      const lastMessage = await ChatMessage.findOne({ userId: socket.userId })
        .sort({ timestamp: -1 })
        .limit(1);

      if (lastMessage && Date.now() - lastMessage.timestamp < 3000) {
        throw new Error('Message rate limit exceeded');
      }

      // Save message
      const chatMessage = new ChatMessage({
        userId: socket.userId,
        username: socket.username,
        text: message.trim(),
        timestamp: Date.now()
      });
      await chatMessage.save();

      // Broadcast message
      const messageData = {
        sender: socket.username,
        senderId: socket.userId,
        text: message.trim(),
        timestamp: Date.now()
      };
      io.emit('chat_message', messageData);

      callback({ success: true });
    } catch (err) {
      console.error('Chat error:', err.message);
      callback({ success: false, error: err.message });
    }
  });

  // Achievements
  socket.on('unlock_achievement', async (achievementName, callback) => {
    try {
      if (!socket.userId) throw new Error('Not authenticated');

      const achievement = await Achievement.findOneAndUpdate(
        { userId: socket.userId, name: achievementName },
        { $set: { unlocked: true, unlockedAt: new Date() } },
        { upsert: true, new: true }
      );

      // Notify player
      socket.emit('achievement_unlocked', achievement);

      callback({ success: true });
    } catch (err) {
      console.error('Achievement unlock error:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    try {
      if (socket.userId) {
        await Player.updateOne(
          { userId: socket.userId },
          { $set: { isOnline: false, lastOnline: new Date() } }
        );

        // Handle active battles
        const activeBattles = await Battle.find({
          'players.userId': socket.userId,
          status: { $in: ['waiting', 'active'] }
        });

        for (const battle of activeBattles) {
          await endBattle(battle._id, 'player_disconnected');
        }
      }
    } catch (err) {
      console.error('Disconnect handler error:', err);
    }
  });
});

// Battle functions
async function findRandomOpponent(socket) {
  // Try to find existing waiting battle
  const availableBattle = await Battle.findOneAndUpdate(
    {
      mode: 'random',
      status: 'waiting',
      'players.0': { $exists: true },
      'players.1': { $exists: false },
      'players.userId': { $ne: socket.userId }
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
    socket.join(availableBattle._id);
    io.to(availableBattle._id).emit('battle_found', availableBattle);
    
    // Start battle after 3 seconds
    setTimeout(() => startBattle(availableBattle._id), 3000);
    return availableBattle;
  }

  // Create new battle
  const newBattle = new Battle({
    mode: 'random',
    status: 'waiting',
    players: [{
      userId: socket.userId,
      username: socket.username,
      score: 0,
      cps: 0,
      lastClicks: []
    }],
    duration: 30000 // 30 seconds
  });

  await newBattle.save();
  socket.join(newBattle._id);

  // Timeout for finding opponent (15 seconds)
  setTimeout(async () => {
    const battle = await Battle.findById(newBattle._id);
    if (battle && battle.status === 'waiting') {
      await Battle.findByIdAndDelete(battle._id);
      io.to(battle._id).emit('battle_cancelled');
    }
  }, 15000);

  return newBattle;
}

async function startBattle(battleId) {
  const battle = await Battle.findByIdAndUpdate(
    battleId,
    { $set: { status: 'active', startTime: new Date() } },
    { new: true }
  );

  if (!battle) return;

  io.to(battleId).emit('battle_start', {
    battleId: battle._id,
    duration: battle.duration,
    players: battle.players
  });

  // Battle timer
  const battleInterval = setInterval(async () => {
    const updatedBattle = await Battle.findById(battleId);
    if (!updatedBattle) {
      clearInterval(battleInterval);
      return;
    }

    const timeLeft = updatedBattle.startTime.getTime() + updatedBattle.duration - Date.now();
    if (timeLeft <= 0) {
      clearInterval(battleInterval);
      await endBattle(battleId);
    } else {
      // Update battle state
      io.to(battleId).emit('battle_update', updatedBattle);
    }
  }, 1000);
}

async function endBattle(battleId, reason = 'completed') {
  const battle = await Battle.findById(battleId);
  if (!battle || battle.status === 'ended') return;

  battle.status = 'ended';
  battle.endTime = new Date();
  battle.endReason = reason;

  // Determine winner
  if (battle.players.length === 2) {
    if (battle.players[0].score > battle.players[1].score) {
      battle.winner = battle.players[0].userId;
    } else if (battle.players[0].score < battle.players[1].score) {
      battle.winner = battle.players[1].userId;
    }
  }

  await battle.save();

  // Send results
  io.to(battleId).emit('battle_end', {
    battleId: battle._id,
    winner: battle.winner,
    scores: battle.players.map(p => ({
      userId: p.userId,
      username: p.username,
      score: p.score
    })),
    reason
  });

  // Clean up
  setTimeout(() => {
    io.socketsLeave(battleId);
  }, 5000);
}

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
