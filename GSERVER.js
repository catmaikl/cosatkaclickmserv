const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

// Подключение к MongoDB
mongoose.connect('mongodb+srv://cat743000:5IN74Ae8JQ1133Rr@cluster0.27kkcmn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Схемы MongoDB
const PlayerSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  score: Number,
  level: Number,
  perclick: Number,
  persecond: Number,
  totalClicks: Number,
  clan: String,
  clanRole: { type: String, enum: ['member', 'moderator', 'leader'], default: 'member' },
  lastActive: Date,
  stats: {
    battlesWon: { type: Number, default: 0 },
    battlesLost: { type: Number, default: 0 },
    battlesDraw: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0 },
    fishCaught: { type: Number, default: 0 }
  }
});

const ClanSchema = new mongoose.Schema({
  name: { type: String, unique: true },
  tag: { type: String, unique: true, maxlength: 4 },
  description: String,
  founder: String,
  members: [String],
  level: { type: Number, default: 1 },
  experience: { type: Number, default: 0 },
  chat: [{
    username: String,
    message: String,
    timestamp: Date
  }],
  goals: [{
    name: String,
    description: String,
    target: Number,
    progress: { type: Number, default: 0 },
    reward: Number,
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const GlobalEventSchema = new mongoose.Schema({
  name: String,
  description: String,
  type: { type: String, enum: ['clicking', 'fishing', 'battles'] },
  target: Number,
  progress: { type: Number, default: 0 },
  reward: Number,
  participants: [String],
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  active: { type: Boolean, default: true }
});

const BattleSchema = new mongoose.Schema({
  player1: String,
  player2: String,
  score1: Number,
  score2: Number,
  winner: String,
  duration: Number,
  timestamp: { type: Date, default: Date.now }
});

const Player = mongoose.model('Player', PlayerSchema);
const Clan = mongoose.model('Clan', ClanSchema);
const GlobalEvent = mongoose.model('GlobalEvent', GlobalEventSchema);
const Battle = mongoose.model('Battle', BattleSchema);

// Инициализация сервера
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Хранилище активных баттлов
const activeBattles = new Map();
const waitingPlayers = new Map();
const playerSockets = new Map();
let currentGlobalEvent = null;

// Функция для создания глобального события
async function createGlobalEvent() {
  // Завершаем текущее событие, если оно есть
  if (currentGlobalEvent) {
    currentGlobalEvent.active = false;
    currentGlobalEvent.endTime = new Date();
    await currentGlobalEvent.save();
  }

  // Типы событий
  const eventTypes = [
    {
      name: "Китовая буря",
      description: "Соберите 1,000,000 кликов всем миром!",
      type: "clicking",
      target: 1000000,
      reward: 500000
    },
    {
      name: "Рыбный день",
      description: "Поймайте 10,000 рыб вместе!",
      type: "fishing",
      target: 10000,
      reward: 250000
    },
    {
      name: "Война кланов",
      description: "Проведите 500 баттлов между кланами!",
      type: "battles",
      target: 500,
      reward: 750000
    }
  ];

  // Выбираем случайное событие
  const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
  
  // Создаем новое событие
  currentGlobalEvent = new GlobalEvent({
    ...eventType,
    progress: 0,
    participants: [],
    active: true
  });

  await currentGlobalEvent.save();
  
  // Уведомляем всех игроков
  io.emit('global_event_start', currentGlobalEvent.toObject());
  
  // Запланировать завершение события через 24 часа
  setTimeout(async () => {
    if (currentGlobalEvent && currentGlobalEvent.active) {
      await endGlobalEvent();
    }
  }, 24 * 60 * 60 * 1000);
}

// Функция для завершения глобального события
async function endGlobalEvent() {
  currentGlobalEvent.active = false;
  currentGlobalEvent.endTime = new Date();
  
  // Награждаем участников, если цель достигнута
  if (currentGlobalEvent.progress >= currentGlobalEvent.target) {
    const rewardPerPlayer = currentGlobalEvent.reward / currentGlobalEvent.participants.length;
    
    for (const username of currentGlobalEvent.participants) {
      await Player.updateOne(
        { username },
        { $inc: { score: rewardPerPlayer, 'stats.totalEarned': rewardPerPlayer } }
      );
      
      const playerSocket = playerSockets.get(username);
      if (playerSocket) {
        playerSocket.emit('notification', {
          type: 'success',
          message: `Глобальное событие "${currentGlobalEvent.name}" завершено! Награда: ${Math.floor(rewardPerPlayer)} косаток`
        });
      }
    }
  }
  
  await currentGlobalEvent.save();
  io.emit('global_event_end', currentGlobalEvent.toObject());
  currentGlobalEvent = null;
  
  // Запускаем новое событие через 6 часов
  setTimeout(createGlobalEvent, 6 * 60 * 60 * 1000);
}

// API endpoints
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await Player.find()
      .sort({ score: -1 })
      .limit(100)
      .select('username score level clan stats');
    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/clan-leaderboard', async (req, res) => {
  try {
    const clanLeaderboard = await Clan.find()
      .sort({ level: -1, experience: -1 })
      .limit(50)
      .select('name tag level experience members');
    res.json(clanLeaderboard);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/global-events', async (req, res) => {
  try {
    const events = await GlobalEvent.find()
      .sort({ startTime: -1 })
      .limit(5);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/submit-score', async (req, res) => {
  const { username, score, level, perclick, persecond, totalClicks } = req.body;
  
  try {
    await Player.findOneAndUpdate(
      { username },
      { 
        score,
        level,
        perclick,
        persecond,
        totalClicks,
        lastActive: new Date()
      },
      { upsert: true }
    );
    
    // Обновляем таблицу лидеров
    await Player.updateOne(
      { username },
      { $set: { lastActive: new Date() } }
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/create-clan', async (req, res) => {
  const { username, clanName, clanTag, description } = req.body;
  
  try {
    // Проверяем, есть ли уже игрок в клане
    const player = await Player.findOne({ username });
    if (player.clan) {
      return res.status(400).json({ error: 'Вы уже состоите в клане' });
    }
    
    // Создаем новый клан
    const clan = new Clan({
      name: clanName,
      tag: clanTag.toUpperCase(),
      description,
      founder: username,
      members: [username]
    });
    
    await clan.save();
    
    // Добавляем игрока в клан
    await Player.updateOne(
      { username },
      { 
        clan: clanName,
        clanRole: 'leader'
      }
    );
    
    res.json({ success: true, clan: clan.toObject() });
  } catch (err) {
    if (err.code === 11000) {
      res.status(400).json({ error: 'Клан с таким именем или тегом уже существует' });
    } else {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
});

app.post('/api/join-clan', async (req, res) => {
  const { username, clanTag } = req.body;
  
  try {
    const player = await Player.findOne({ username });
    if (player.clan) {
      return res.status(400).json({ error: 'Вы уже состоите в клане' });
    }
    
    const clan = await Clan.findOne({ tag: clanTag.toUpperCase() });
    if (!clan) {
      return res.status(404).json({ error: 'Клан не найден' });
    }
    
    // Добавляем игрока в клан
    clan.members.push(username);
    await clan.save();
    
    await Player.updateOne(
      { username },
      { 
        clan: clan.name,
        clanRole: 'member'
      }
    );
    
    // Уведомляем членов клана
    clan.members.forEach(member => {
      const memberSocket = playerSockets.get(member);
      if (memberSocket) {
        memberSocket.emit('clan_update', {
          type: 'member_joined',
          username: username,
          clan: clan.toObject()
        });
      }
    });
    
    res.json({ success: true, clan: clan.toObject() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Middleware для проверки аутентификации
io.use(async (socket, next) => {
  const username = socket.handshake.query.username;
  if (!username) return next(new Error('Не указано имя пользователя'));
  
  try {
    let player = await Player.findOne({ username });
    if (!player) {
      player = new Player({ 
        username, 
        score: 0, 
        level: 1,
        perclick: 1,
        persecond: 0,
        totalClicks: 0,
        lastActive: new Date() 
      });
      await player.save();
    } else {
      player.lastActive = new Date();
      await player.save();
    }
    socket.username = username;
    playerSockets.set(username, socket);
    next();
  } catch (err) {
    next(new Error('Ошибка базы данных'));
  }
});

// Обработчики событий Socket.io
io.on('connection', (socket) => {
  console.log(`Пользователь подключен: ${socket.username}`);
  
  // Отправляем текущее глобальное событие новому игроку
  if (currentGlobalEvent) {
    socket.emit('global_event_update', currentGlobalEvent.toObject());
  }
  
  // Обработчик поиска баттла
  socket.on('find_battle', async () => {
    const player = await Player.findOne({ username: socket.username });
    if (!player) return;
    
    // Проверяем, есть ли ожидающие игроки
    if (waitingPlayers.size > 0) {
      // Берем первого ожидающего игрока
      const [opponentUsername, opponentSocket] = waitingPlayers.entries().next().value;
      waitingPlayers.delete(opponentUsername);
      
      // Создаем баттл
      startBattle(socket, opponentSocket);
    } else {
      // Добавляем текущего игрока в очередь ожидания
      waitingPlayers.set(socket.username, socket);
      socket.emit('battle_status', { status: 'searching' });
    }
  });
  
  // Обработчик кликов в баттле
  socket.on('battle_click', ({ battleId }) => {
    const battle = activeBattles.get(battleId);
    if (!battle || !battle.players.includes(socket.username)) return;
    
    // Обновляем счет игрока
    if (battle.players[0] === socket.username) {
      battle.scores[0]++;
    } else {
      battle.scores[1]++;
    }
    
    // Обновляем CPS (кликов в секунду)
    const now = Date.now();
    if (!battle.lastClickTimes[socket.username]) {
      battle.lastClickTimes[socket.username] = now;
      battle.clickCounts[socket.username] = 0;
    }
    
    battle.clickCounts[socket.username]++;
    const timeDiff = (now - battle.lastClickTimes[socket.username]) / 1000;
    if (timeDiff >= 1) {
      battle.cps[socket.username] = battle.clickCounts[socket.username] / timeDiff;
      battle.lastClickTimes[socket.username] = now;
      battle.clickCounts[socket.username] = 0;
    }
    
    // Отправляем обновление всем участникам баттла
    updateBattle(battle);
    
    // Обновляем глобальное событие, если оно активно и связано с кликами
    if (currentGlobalEvent && currentGlobalEvent.active && currentGlobalEvent.type === 'clicking') {
      updateGlobalEventProgress(1);
    }
  });
  
  // Обработчик сообщений в чате клана
  socket.on('clan_chat_message', async ({ message }) => {
    const player = await Player.findOne({ username: socket.username });
    if (!player || !player.clan) return;
    
    const clan = await Clan.findOne({ name: player.clan });
    if (!clan) return;
    
    // Добавляем сообщение в чат клана
    clan.chat.push({
      username: socket.username,
      message,
      timestamp: new Date()
    });
    
    // Сохраняем и отправляем сообщение всем членам клана
    await clan.save();
    
    clan.members.forEach(member => {
      const memberSocket = playerSockets.get(member);
      if (memberSocket) {
        memberSocket.emit('clan_chat_message', {
          username: socket.username,
          message,
          timestamp: new Date()
        });
      }
    });
  });
  
  // Обработчик вклада в цель клана
  socket.on('contribute_to_clan_goal', async ({ goalId, amount }) => {
    const player = await Player.findOne({ username: socket.username });
    if (!player || !player.clan) return;
    
    const clan = await Clan.findOne({ name: player.clan });
    if (!clan) return;
    
    const goal = clan.goals.id(goalId);
    if (!goal || !goal.active) return;
    
    // Проверяем, что у игрока достаточно очков
    if (player.score < amount) {
      socket.emit('notification', {
        type: 'error',
        message: 'Недостаточно косаток для вклада'
      });
      return;
    }
    
    // Обновляем прогресс цели
    goal.progress = Math.min(goal.progress + amount, goal.target);
    
    // Вычитаем очки у игрока
    player.score -= amount;
    player.stats.totalEarned -= amount;
    
    await Promise.all([clan.save(), player.save()]);
    
    // Отправляем обновление всем членам клана
    const updatedGoal = {
      id: goal._id,
      name: goal.name,
      description: goal.description,
      target: goal.target,
      progress: goal.progress,
      reward: goal.reward,
      active: goal.active
    };
    
    clan.members.forEach(member => {
      const memberSocket = playerSockets.get(member);
      if (memberSocket) {
        memberSocket.emit('clan_goal_update', updatedGoal);
      }
    });
    
    // Если цель достигнута, награждаем клан
    if (goal.progress >= goal.target) {
      goal.active = false;
      
      // Награда для клана (опыт)
      clan.experience += goal.reward;
      
      // Проверяем уровень клана
      const expNeeded = clan.level * 1000;
      if (clan.experience >= expNeeded) {
        clan.level += 1;
        clan.experience -= expNeeded;
        
        // Уведомление о повышении уровня клана
        clan.members.forEach(member => {
          const memberSocket = playerSockets.get(member);
          if (memberSocket) {
            memberSocket.emit('notification', {
              type: 'success',
              message: `Ваш клан достиг ${clan.level} уровня!`
            });
          }
        });
      }
      
      await clan.save();
      
      // Награда для всех членов клана
      const memberReward = Math.floor(goal.reward / clan.members.length);
      
      clan.members.forEach(async member => {
        await Player.updateOne(
          { username: member },
          { $inc: { score: memberReward, 'stats.totalEarned': memberReward } }
        );
        
        const memberSocket = playerSockets.get(member);
        if (memberSocket) {
          memberSocket.emit('notification', {
            type: 'success',
            message: `Цель клана "${goal.name}" достигнута! Награда: ${memberReward} косаток`
          });
        }
      });
    }
  });
  
  // Обработчик участия в глобальном событии
  socket.on('participate_in_global_event', async ({ amount }) => {
    if (!currentGlobalEvent || !currentGlobalEvent.active) {
      socket.emit('notification', {
        type: 'error',
        message: 'Нет активных глобальных событий'
      });
      return;
    }
    
    const player = await Player.findOne({ username: socket.username });
    if (!player || player.score < amount) {
      socket.emit('notification', {
        type: 'error',
        message: 'Недостаточно косаток для участия'
      });
      return;
    }
    
    // Добавляем вклад игрока
    currentGlobalEvent.progress = Math.min(
      currentGlobalEvent.progress + amount,
      currentGlobalEvent.target
    );
    
    // Добавляем игрока в участники, если его еще нет
    if (!currentGlobalEvent.participants.includes(socket.username)) {
      currentGlobalEvent.participants.push(socket.username);
    }
    
    // Вычитаем очки у игрока
    player.score -= amount;
    player.stats.totalEarned -= amount;
    
    await Promise.all([currentGlobalEvent.save(), player.save()]);
    
    // Отправляем обновление всем игрокам
    io.emit('global_event_update', currentGlobalEvent.toObject());
    
    socket.emit('notification', {
      type: 'success',
      message: `Ваш вклад в глобальное событие "${currentGlobalEvent.name}" принят!`
    });
    
    // Если событие завершено, награждаем участников
    if (currentGlobalEvent.progress >= currentGlobalEvent.target) {
      await endGlobalEvent();
    }
  });
  
  // Обработчик отключения
  socket.on('disconnect', () => {
    console.log(`Пользователь отключен: ${socket.username}`);
    playerSockets.delete(socket.username);
    
    // Если игрок был в очереди на баттл, удаляем его
    if (waitingPlayers.has(socket.username)) {
      waitingPlayers.delete(socket.username);
    }
    
    // Если игрок был в активном баттле, завершаем баттл
    for (const [battleId, battle] of activeBattles) {
      if (battle.players.includes(socket.username)) {
        endBattle(battleId, 'disconnect');
        break;
      }
    }
  });
});

// Функция для обновления прогресса глобального события
async function updateGlobalEventProgress(amount) {
  if (!currentGlobalEvent || !currentGlobalEvent.active) return;
  
  currentGlobalEvent.progress += amount;
  
  // Добавляем случайных участников, если их мало
  if (currentGlobalEvent.participants.length < 10 && Math.random() < 0.1) {
    const randomPlayers = await Player.aggregate([{ $sample: { size: 1 } }]);
    if (randomPlayers.length > 0 && !currentGlobalEvent.participants.includes(randomPlayers[0].username)) {
      currentGlobalEvent.participants.push(randomPlayers[0].username);
    }
  }
  
  await currentGlobalEvent.save();
  io.emit('global_event_update', currentGlobalEvent.toObject());
  
  // Проверяем, достигнута ли цель
  if (currentGlobalEvent.progress >= currentGlobalEvent.target) {
    await endGlobalEvent();
  }
}

// Функция для начала баттла
function startBattle(player1Socket, player2Socket) {
  const battleId = generateBattleId();
  const battle = {
    id: battleId,
    players: [player1Socket.username, player2Socket.username],
    scores: [0, 0],
    cps: { 
      [player1Socket.username]: 0, 
      [player2Socket.username]: 0 
    },
    lastClickTimes: {},
    clickCounts: {},
    startTime: new Date(),
    timeLeft: 30,
    timer: setInterval(() => {
      battle.timeLeft--;
      
      // Обновляем время у обоих игроков
      const player1Update = {
        opponentScore: battle.scores[1],
        opponentCps: battle.cps[player2Socket.username] || 0,
        timeLeft: battle.timeLeft
      };
      
      const player2Update = {
        opponentScore: battle.scores[0],
        opponentCps: battle.cps[player1Socket.username] || 0,
        timeLeft: battle.timeLeft
      };
      
      player1Socket.emit('battle_update', player1Update);
      player2Socket.emit('battle_update', player2Update);
      
      // Завершаем баттл, если время вышло
      if (battle.timeLeft <= 0) {
        endBattle(battleId, 'timeout');
      }
    }, 1000)
  };
  
  activeBattles.set(battleId, battle);
  
  // Отправляем уведомление игрокам
  player1Socket.emit('battle_start', { 
    battleId,
    opponent: player2Socket.username,
    opponentLevel: 1 // В реальной игре нужно получать уровень из БД
  });
  
  player2Socket.emit('battle_start', { 
    battleId,
    opponent: player1Socket.username,
    opponentLevel: 1 // В реальной игре нужно получать уровень из БД
  });
  
  // Обновляем глобальное событие, если оно активно и связано с баттлами
  if (currentGlobalEvent && currentGlobalEvent.active && currentGlobalEvent.type === 'battles') {
    updateGlobalEventProgress(1);
  }
}

// Функция для завершения баттла
async function endBattle(battleId, reason) {
  const battle = activeBattles.get(battleId);
  if (!battle) return;
  
  clearInterval(battle.timer);
  activeBattles.delete(battleId);
  
  // Определяем победителя
  let winner, battleResult;
  if (reason === 'disconnect') {
    const disconnectedPlayer = battle.players.find(
      player => !playerSockets.has(player)
    );
    winner = battle.players.find(player => player !== disconnectedPlayer);
    battleResult = { winner, reason: 'opponent_disconnected' };
  } else {
    if (battle.scores[0] > battle.scores[1]) {
      winner = battle.players[0];
    } else if (battle.scores[1] > battle.scores[0]) {
      winner = battle.players[1];
    } else {
      winner = null; // Ничья
    }
    battleResult = { winner, reason: 'timeout' };
  }
  
  // Сохраняем результат баттла в БД
  const battleRecord = new Battle({
    player1: battle.players[0],
    player2: battle.players[1],
    score1: battle.scores[0],
    score2: battle.scores[1],
    winner: winner,
    duration: 30 - battle.timeLeft,
    timestamp: new Date()
  });
  await battleRecord.save();
  
  // Награды
  const winnerReward = 100;
  const loserReward = 20;
  const drawReward = 50;
  
  // Обновляем статистику игроков
  battle.players.forEach(async (player, index) => {
    const isWinner = winner === player;
    const isDraw = winner === null;
    const reward = isWinner ? winnerReward : (isDraw ? drawReward : loserReward);
    
    const update = {
      $inc: { 
        score: reward,
        'stats.totalEarned': reward,
        [`stats.battles${isWinner ? 'Won' : (isDraw ? 'Draw' : 'Lost')}`]: 1
      }
    };
    
    // Если игроки из разных кланов, добавляем опыт кланам
    const player1 = await Player.findOne({ username: battle.players[0] });
    const player2 = await Player.findOne({ username: battle.players[1] });
    
    if (player1.clan && player2.clan && player1.clan !== player2.clan) {
      const clanUpdate = { $inc: { experience: isWinner ? 50 : (isDraw ? 25 : 10) } };
      await Clan.updateOne({ name: player1.clan }, clanUpdate);
      await Clan.updateOne({ name: player2.clan }, clanUpdate);
    }
    
    await Player.updateOne({ username: player }, update);
    
    const playerSocket = playerSockets.get(player);
    if (playerSocket) {
      playerSocket.emit('battle_end', {
        result: isWinner ? 'win' : (isDraw ? 'draw' : 'loss'),
        yourScore: battle.scores[index],
        opponentScore: battle.scores[index === 0 ? 1 : 0],
        reward: reward
      });
    }
  });
}

// Вспомогательные функции
function generateBattleId() {
  return Math.random().toString(36).substr(2, 9);
}

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  
  // Проверяем активное глобальное событие
  currentGlobalEvent = await GlobalEvent.findOne({ active: true });
  
  // Если нет активного события, создаем новое
  if (!currentGlobalEvent) {
    await createGlobalEvent();
  } else {
    // Проверяем, не завершилось ли событие
    const eventDuration = new Date() - currentGlobalEvent.startTime;
    if (eventDuration > 24 * 60 * 60 * 1000) {
      await endGlobalEvent();
      await createGlobalEvent();
    } else {
      // Запланировать завершение события через оставшееся время
      setTimeout(async () => {
        if (currentGlobalEvent && currentGlobalEvent.active) {
          await endGlobalEvent();
        }
      }, 24 * 60 * 60 * 1000 - eventDuration);
    }
  }
});