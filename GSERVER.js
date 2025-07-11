const express = require('express');
const mongoose = require('mongoose');
const socketio = require('socket.io');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

// Middleware

// Apply CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", 
    "https://cosatka-clickgame-277.netlify.app");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  next();
});

// For Socket.IO
const io = socketio(server, {
  cors: {
    origin: [
      "https://cosatka-clickgame-277.netlify.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  path: "/socket.io"  // Explicitly set the path
});

app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cosatkaClicker', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Models
const User = mongoose.model('User', new mongoose.Schema({
  userId: String,
  userName: String,
  password: String,
  refreshToken: String,
  createdAt: { type: Date, default: Date.now }
}));

const GameSave = mongoose.model('GameSave', new mongoose.Schema({
  userId: String,
  gameData: Object,
  lastUpdated: { type: Date, default: Date.now }
}));

const Leaderboard = mongoose.model('Leaderboard', new mongoose.Schema({
  userId: String,
  userName: String,
  score: Number,
  level: Number,
  lastUpdated: { type: Date, default: Date.now }
}));

const Battle = mongoose.model('Battle', new mongoose.Schema({
  player1: String,
  player2: String,
  player1Score: Number,
  player2Score: Number,
  winner: String,
  createdAt: { type: Date, default: Date.now }
}));

// Добавляем в GSERVER.js
const Clan = mongoose.model('Clan', new mongoose.Schema({
  name: String,
  creator: String,
  members: [{
    userId: String,
    userName: String,
    joinDate: Date,
    contribution: Number
  }],
  level: Number,
  experience: Number,
  created: { type: Date, default: Date.now }
}));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.sendStatus(401);
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Routes
app.post('/api/auth/anonymous', async (req, res) => {
  try {
    const { userId, userName } = req.body;
    
    // Create or update user
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, userName });
      await user.save();
    }
    
    // Generate tokens
    const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    
    // Update refresh token
    user.refreshToken = refreshToken;
    await user.save();
    
    res.json({ accessToken, refreshToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.sendStatus(401);
    
    const user = await User.findOne({ refreshToken });
    if (!user) return res.sendStatus(403);
    
    jwt.verify(refreshToken, JWT_SECRET, (err, decoded) => {
      if (err) return res.sendStatus(403);
      
      const accessToken = jwt.sign({ userId: decoded.userId }, JWT_SECRET, { expiresIn: '15m' });
      res.json({ accessToken });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Новые маршруты
app.post('/api/clans/create', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.user.userId;
    
    const existing = await Clan.findOne({ name });
    if (existing) {
      return res.status(400).json({ error: 'Clan with this name already exists' });
    }
    
    const user = await User.findOne({ userId });
    const clan = new Clan({
      name,
      creator: userId,
      members: [{
        userId,
        userName: user.userName,
        joinDate: Date.now(),
        contribution: 0
      }],
      level: 1,
      experience: 0
    });
    
    await clan.save();
    res.json({ success: true, clan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create clan' });
  }
});

app.post('/api/clans/join', authenticateToken, async (req, res) => {
  try {
    const { clanName } = req.body;
    const userId = req.user.userId;
    
    const clan = await Clan.findOne({ name: clanName });
    if (!clan) {
      return res.status(404).json({ error: 'Clan not found' });
    }
    
    const user = await User.findOne({ userId });
    clan.members.push({
      userId,
      userName: user.userName,
      joinDate: Date.now(),
      contribution: 0
    });
    
    await clan.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join clan' });
  }
});

app.get('/api/clans/top', async (req, res) => {
  try {
    const clans = await Clan.find()
      .sort({ level: -1, experience: -1 })
      .limit(10);
    
    res.json(clans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load clans' });
  }
});

app.post('/api/save', authenticateToken, async (req, res) => {
  try {
    const { userId, gameData } = req.body;
    
    let save = await GameSave.findOne({ userId });
    if (!save) {
      save = new GameSave({ userId, gameData });
    } else {
      save.gameData = gameData;
      save.lastUpdated = Date.now();
    }
    
    await save.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save game' });
  }
});

app.get('/api/load', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const save = await GameSave.findOne({ userId });
    
    if (!save) {
      return res.status(404).json({ error: 'No save found' });
    }
    
    res.json({ gameData: save.gameData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load game' });
  }
});

app.post('/api/leaderboard', authenticateToken, async (req, res) => {
  try {
    const { userId, userName, score, level } = req.body;
    
    let entry = await Leaderboard.findOne({ userId });
    if (!entry) {
      entry = new Leaderboard({ userId, userName, score, level });
    } else {
      entry.userName = userName;
      entry.score = score;
      entry.level = level;
      entry.lastUpdated = Date.now();
    }
    
    await entry.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await Leaderboard.find()
      .sort({ score: -1 })
      .limit(100);
    
    res.json(leaderboard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// Socket.io for battles
const battleQueue = [];
const activeBattles = {};

io.on('connection', (socket) => {
  console.log('New client connected');
  
  socket.on('joinBattleQueue', (userId) => {
    if (!battleQueue.includes(userId)) {
      battleQueue.push(userId);
      checkBattleQueue();
    }
  });
  
  socket.on('battleClick', ({ userId, score, cps }) => {
    const battleId = Object.keys(activeBattles).find(id => 
      activeBattles[id].player1 === userId || activeBattles[id].player2 === userId
    );
    
    if (battleId) {
      const battle = activeBattles[battleId];
      if (battle.player1 === userId) {
        battle.player1Score = score;
        io.to(battle.socket2).emit('opponentUpdate', { 
          score: battle.player1Score, 
          cps: cps 
        });
      } else {
        battle.player2Score = score;
        io.to(battle.socket1).emit('opponentUpdate', { 
          score: battle.player2Score, 
          cps: cps 
        });
      }
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

function checkBattleQueue() {
  if (battleQueue.length >= 2) {
    const player1 = battleQueue.shift();
    const player2 = battleQueue.shift();
    
    const battleId = `battle_${Date.now()}`;
    activeBattles[battleId] = {
      player1,
      player2,
      player1Score: 0,
      player2Score: 0,
      socket1: null,
      socket2: null,
      timer: null
    };
    
    // Find sockets for players
    const sockets = Object.values(io.sockets.sockets);
    const socket1 = sockets.find(s => s.userId === player1);
    const socket2 = sockets.find(s => s.userId === player2);
    
    if (socket1 && socket2) {
      activeBattles[battleId].socket1 = socket1.id;
      activeBattles[battleId].socket2 = socket2.id;
      
      // Get user names
      User.find({ userId: { $in: [player1, player2] } })
        .then(users => {
          const user1 = users.find(u => u.userId === player1);
          const user2 = users.find(u => u.userId === player2);
          
          // Start battle
          socket1.emit('battleStart', { 
            opponentName: user2?.userName || 'Соперник',
            timeLeft: 30
          });
          
          socket2.emit('battleStart', { 
            opponentName: user1?.userName || 'Соперник',
            timeLeft: 30
          });
          
          // Set battle timer
          activeBattles[battleId].timer = setTimeout(() => {
            endBattle(battleId);
          }, 30000);
        });
    }
  }
}

function endBattle(battleId) {
  const battle = activeBattles[battleId];
  if (!battle) return;
  
  clearTimeout(battle.timer);
  
  const winner = battle.player1Score > battle.player2Score ? 
    battle.player1 : battle.player2;
  
  // Notify players
  if (battle.socket1) {
    io.to(battle.socket1).emit('battleEnd', { 
      winner,
      playerScore: battle.player1Score,
      opponentScore: battle.player2Score
    });
  }
  
  if (battle.socket2) {
    io.to(battle.socket2).emit('battleEnd', { 
      winner,
      playerScore: battle.player2Score,
      opponentScore: battle.player1Score
    });
  }
  
  // Save battle result
  new Battle({
    player1: battle.player1,
    player2: battle.player2,
    player1Score: battle.player1Score,
    player2Score: battle.player2Score,
    winner
  }).save();
  
  delete activeBattles[battleId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
