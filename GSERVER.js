const express = require('express');
const mongoose = require('mongoose');
const socketio = require('socket.io');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const corsOptions = {
  origin: ["https://cosatka-clickgame-277.netlify.app", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const io = socketio(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  allowUpgrades: true
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

const DailyReward = mongoose.model('DailyReward', new mongoose.Schema({
  userId: String,
  lastClaimed: Date,
  streak: Number,
  nextRewardDay: Number
}));

const QuestProgress = mongoose.model('QuestProgress', new mongoose.Schema({
  userId: String,
  dailyQuests: [{
    questId: String,
    progress: Number,
    completed: Boolean,
    completedAt: Date
  }],
  achievementQuests: [{
    questId: String,
    progress: Number,
    completed: Boolean,
    completedAt: Date
  }],
  updatedAt: { type: Date, default: Date.now }
}));

const ShopPurchase = mongoose.model('ShopPurchase', new mongoose.Schema({
  userId: String,
  itemId: String,
  purchasedAt: { type: Date, default: Date.now }
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
    
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, userName });
      await user.save();
      
      // Initialize user progress
      await new DailyReward({
        userId,
        streak: 0,
        nextRewardDay: 1
      }).save();
      
      await new QuestProgress({
        userId,
        dailyQuests: [],
        achievementQuests: []
      }).save();
    }
    
    const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    
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

// Game data routes
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

// Leaderboard routes
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

// Clan routes
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
    
    // Check if already in clan
    if (clan.members.some(m => m.userId === userId)) {
      return res.status(400).json({ error: 'Already in this clan' });
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

app.get('/api/clans/my', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const clan = await Clan.findOne({ 'members.userId': userId });
    
    if (!clan) {
      return res.status(404).json({ error: 'Not in any clan' });
    }
    
    res.json(clan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load clan info' });
  }
});

// Daily rewards routes
app.post('/api/rewards/claim', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    let reward = await DailyReward.findOne({ userId });
    if (!reward) {
      reward = new DailyReward({
        userId,
        streak: 1,
        nextRewardDay: 1,
        lastClaimed: today
      });
    } else {
      const lastClaimed = reward.lastClaimed ? 
        new Date(reward.lastClaimed.getFullYear(), reward.lastClaimed.getMonth(), reward.lastClaimed.getDate()) : 
        null;
      
      if (lastClaimed && lastClaimed.getTime() === today.getTime()) {
        return res.status(400).json({ error: 'Already claimed today' });
      }
      
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (lastClaimed && lastClaimed.getTime() === yesterday.getTime()) {
        reward.streak++;
      } else {
        reward.streak = 1;
      }
      
      reward.lastClaimed = today;
      reward.nextRewardDay = (reward.nextRewardDay % 7) + 1;
    }
    
    await reward.save();
    
    // Calculate rewards based on streak day
    const rewards = [
      { currency: 50, score: 100 },
      { currency: 75, score: 150 },
      { currency: 100, score: 200 },
      { currency: 150, score: 300 },
      { currency: 200, score: 500 },
      { currency: 300, score: 750 },
      { currency: 500, score: 1000, bonus: "2x boost for 1 day" }
    ];
    
    const dayIndex = (reward.streak - 1) % 7;
    const todayReward = rewards[dayIndex];
    
    res.json({
      success: true,
      reward: todayReward,
      streak: reward.streak,
      day: dayIndex + 1
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to claim reward' });
  }
});

app.get('/api/rewards/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const reward = await DailyReward.findOne({ userId });
    
    if (!reward) {
      return res.json({
        canClaim: true,
        streak: 0,
        nextDay: 1
      });
    }
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastClaimed = reward.lastClaimed ? 
      new Date(reward.lastClaimed.getFullYear(), reward.lastClaimed.getMonth(), reward.lastClaimed.getDate()) : 
      null;
    
    res.json({
      canClaim: !lastClaimed || lastClaimed.getTime() !== today.getTime(),
      streak: reward.streak,
      nextDay: reward.nextRewardDay
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get reward status' });
  }
});

// Quests routes
app.get('/api/quests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const quests = await QuestProgress.findOne({ userId });
    
    if (!quests) {
      // Initialize default quests if none exist
      const defaultQuests = {
        userId,
        dailyQuests: [
          { questId: "click_100", progress: 0, completed: false },
          { questId: "earn_1000", progress: 0, completed: false }
        ],
        achievementQuests: [
          { questId: "level_10", progress: 0, completed: false },
          { questId: "auto_100", progress: 0, completed: false }
        ]
      };
      
      const newQuests = new QuestProgress(defaultQuests);
      await newQuests.save();
      return res.json(defaultQuests);
    }
    
    res.json(quests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load quests' });
  }
});

app.post('/api/quests/update', authenticateToken, async (req, res) => {
  try {
    const { userId, questId, progress, isDaily } = req.body;
    
    const quests = await QuestProgress.findOne({ userId });
    if (!quests) {
      return res.status(404).json({ error: 'No quests found' });
    }
    
    const questArray = isDaily ? quests.dailyQuests : quests.achievementQuests;
    const quest = questArray.find(q => q.questId === questId);
    
    if (!quest) {
      return res.status(404).json({ error: 'Quest not found' });
    }
    
    quest.progress = progress;
    if (progress >= getQuestTarget(questId)) {
      quest.completed = true;
      quest.completedAt = new Date();
    }
    
    await quests.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update quest' });
  }
});

function getQuestTarget(questId) {
  const targets = {
    click_100: 100,
    earn_1000: 1000,
    level_10: 10,
    auto_100: 100
  };
  
  return targets[questId] || 0;
}

// Shop routes
app.get('/api/shop/items', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get all available items
    const items = [
      {
        id: "skin_ocean",
        name: "Океанский скин",
        description: "Косатка в океанском стиле",
        price: 1000,
        type: "skin",
        effect: "theme_ocean"
      },
      {
        id: "skin_space",
        name: "Космический скин",
        description: "Косатка в космическом стиле",
        price: 2000,
        type: "skin",
        effect: "theme_space"
      },
      {
        id: "boost_2x",
        name: "2x буст на 1 час",
        description: "Удваивает все доходы на 1 час",
        price: 500,
        type: "boost",
        effect: { multiplier: 2, duration: 3600 }
      },
      {
        id: "skill_point",
        name: "Очко навыков",
        description: "Дополнительное очко для дерева навыков",
        price: 1500,
        type: "skill",
        effect: { points: 1 }
      }
    ];
    
    // Get user's purchased items
    const purchases = await ShopPurchase.find({ userId });
    const purchasedItems = purchases.map(p => p.itemId);
    
    // Add purchased flag to items
    const itemsWithStatus = items.map(item => ({
      ...item,
      purchased: purchasedItems.includes(item.id)
    }));
    
    res.json(itemsWithStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load shop items' });
  }
});

app.post('/api/shop/buy', authenticateToken, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { userId, itemId } = req.body;

    // 1. Validate the item exists and get its details
    const shopItem = await ShopItem.findOne({ itemId }).session(session);
    if (!shopItem) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Item not found' });
    }

    // 2. Check if already purchased (for non-consumables like skins)
    if (shopItem.type === 'skin') {
      const existingPurchase = await ShopPurchase.findOne({ 
        userId, 
        itemId 
      }).session(session);
      
      if (existingPurchase) {
        await session.abortTransaction();
        return res.status(400).json({ 
          error: 'You already own this item',
          code: 'ALREADY_OWNED'
        });
      }
    }

    // 3. Get the game save with pessimistic locking
    const gameSave = await GameSave.findOneAndUpdate(
      { userId },
      { $set: { lockedForPurchase: true } },
      { new: true, session }
    ).select('gameData');

    if (!gameSave) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Game save not found' });
    }

    // 4. Check currency balance
    if (gameSave.gameData.shop.currency < shopItem.price) {
      await session.abortTransaction();
      return res.status(400).json({ 
        error: 'Not enough currency',
        code: 'INSUFFICIENT_FUNDS',
        required: shopItem.price,
        current: gameSave.gameData.shop.currency
      });
    }

    // 5. Apply the purchase
    // Deduct currency
    await GameSave.updateOne(
      { userId },
      { 
        $inc: { 'gameData.shop.currency': -shopItem.price },
        $unset: { lockedForPurchase: 1 }
      },
      { session }
    );

    // Record purchase
    await new ShopPurchase({
      userId,
      itemId,
      price: shopItem.price,
      purchasedAt: new Date()
    }).save({ session });

    // Apply item effects to game data
    let update = {};
    switch (shopItem.type) {
      case 'skin':
        update = { $addToSet: { 'gameData.unlockedSkins': itemId } };
        break;
      case 'boost':
        update = { 
          $push: { 'gameData.activeBoosts': {
            id: itemId,
            multiplier: shopItem.effect.multiplier,
            expiresAt: new Date(Date.now() + shopItem.effect.duration * 1000)
          }}
        };
        break;
      case 'skill':
        update = { $inc: { 'gameData.skillPoints': shopItem.effect.points } };
        break;
    }

    if (Object.keys(update).length > 0) {
      await GameSave.updateOne({ userId }, update, { session });
    }

    // 6. Invalidate cache
    await redis.del(`gameSave:${userId}`);
    await redis.del(`inventory:${userId}`);

    await session.commitTransaction();

    // 7. Emit real-time update
    io.to(userId).emit('inventoryUpdate', {
      itemId,
      action: 'purchased'
    });

    res.json({ 
      success: true,
      newBalance: gameSave.gameData.shop.currency - shopItem.price,
      item: shopItem
    });

  } catch (error) {
    await session.abortTransaction();
    
    // Log detailed error for debugging
    console.error('Shop purchase failed:', {
      userId,
      itemId,
      error: error.message,
      stack: error.stack
    });

    // Specific error for duplicate purchases that might slip through
    if (error.code === 11000) {
      return res.status(400).json({ 
        error: 'You already own this item',
        code: 'DUPLICATE_PURCHASE'
      });
    }

    res.status(500).json({ 
      error: 'Failed to complete purchase',
      code: 'PURCHASE_FAILED'
    });
  } finally {
    session.endSession();
  }
});

// Socket.io for battles and real-time updates
const battleQueue = [];
const activeBattles = {};

io.on('connection', (socket) => {
  console.log('New client connected');
  
  // Authenticate socket
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.userId;
      
      const user = await User.findOne({ userId: decoded.userId });
      if (user) {
        socket.userName = user.userName;
      }
      
      console.log(`User ${decoded.userId} authenticated on socket`);
    } catch (err) {
      console.error('Socket authentication error:', err);
      socket.disconnect();
    }
  });
  
  // Battle queue
  socket.on('joinBattleQueue', () => {
    if (!socket.userId) return;
    
    if (!battleQueue.includes(socket.userId)) {
      battleQueue.push(socket.userId);
      checkBattleQueue();
    }
  });
  
  socket.on('leaveBattleQueue', () => {
    if (!socket.userId) return;
    
    const index = battleQueue.indexOf(socket.userId);
    if (index !== -1) {
      battleQueue.splice(index, 1);
    }
  });
  
  // Battle updates
  socket.on('battleClick', ({ score, cps }) => {
    if (!socket.userId) return;
    
    const battleId = Object.keys(activeBattles).find(id => 
      activeBattles[id].player1 === socket.userId || 
      activeBattles[id].player2 === socket.userId
    );
    
    if (battleId) {
      const battle = activeBattles[battleId];
      if (battle.player1 === socket.userId) {
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
  
  // Clan chat
  socket.on('clanMessage', async (message) => {
    if (!socket.userId || !message) return;
    
    try {
      const clan = await Clan.findOne({ 'members.userId': socket.userId });
      if (!clan) return;
      
      io.emit(`clan_${clan._id}`, {
        userId: socket.userId,
        userName: socket.userName || 'Anonymous',
        message: message,
        timestamp: new Date()
      });
    } catch (err) {
      console.error('Clan message error:', err);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
    
    // Remove from battle queue if present
    if (socket.userId) {
      const index = battleQueue.indexOf(socket.userId);
      if (index !== -1) {
        battleQueue.splice(index, 1);
      }
    }
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

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});