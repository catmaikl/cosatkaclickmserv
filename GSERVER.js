// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Инициализация приложения
const app = express();
const server = http.createServer(app);

// Настройка CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Конфигурация
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-here';

// Временное хранилище данных в памяти
const users = new Map(); // userId -> userData
const leaderboard = [];
const activeBattles = new Map(); // battleId -> battleData
const shopItems = [
  {
    id: "boost_2x",
    name: "2x буст на 1 час",
    description: "Удваивает все доходы на 1 час",
    price: 500,
    type: "boost",
    effect: { multiplier: 2, duration: 3600 },
    purchased: false,
  },
  {
    id: "skill_point",
    name: "Очко навыков",
    description: "Дополнительное очко для дерева навыков",
    price: 1500,
    type: "skill",
    effect: { points: 1 },
    purchased: false,
  },
  {
    id: "skin5",
    name: "Киса (Премиум)",
    description: "Красотка!",
    price: 2500,
    type: "skin",
    effect: "theme_skin5",
    purchased: false,
  },
  {
    id: "skin7",
    name: "Прятки! (Премиум)",
    description: "Косатка любит прятки",
    price: 3500,
    type: "skin",
    effect: "theme_skin7",
    purchased: false,
  },
  {
    id: "skin_premium",
    name: "CYBERPUNK КОСАТКА",
    description: "Самый эксклюзивный скин",
    price: 5000,
    type: "skin",
    effect: "theme_premium",
    purchased: false,
  }
];

// Генерация токенов
function generateTokens(userId, userName) {
  const accessToken = jwt.sign(
    { userId, userName },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
  
  const refreshToken = jwt.sign(
    { userId, userName },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  
  return { accessToken, refreshToken };
}

// Верификация токена
function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret);
  } catch (err) {
    return null;
  }
}

// API Routes
app.post('/api/auth/anonymous', (req, res) => {
  const { userId, userName } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  
  const tokens = generateTokens(userId, userName || 'Anonymous');
  
  // Сохраняем пользователя
  if (!users.has(userId)) {
    users.set(userId, {
      userId,
      userName: userName || 'Anonymous',
      refreshToken: tokens.refreshToken,
      gameData: null,
      lastSeen: Date.now()
    });
  }
  
  res.json(tokens);
});

app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }
  
  const decoded = verifyToken(refreshToken, JWT_REFRESH_SECRET);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
  
  const user = users.get(decoded.userId);
  if (!user || user.refreshToken !== refreshToken) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
  
  const tokens = generateTokens(decoded.userId, decoded.userName);
  user.refreshToken = tokens.refreshToken;
  users.set(decoded.userId, user);
  
  res.json(tokens);
});

app.post('/api/auth/verify', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ valid: false });
  }
  
  const decoded = verifyToken(token, JWT_SECRET);
  res.json({ valid: !!decoded });
});

app.post('/api/save', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { userId, gameData } = req.body;
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const decoded = verifyToken(token, JWT_SECRET);
  if (!decoded || decoded.userId !== userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  user.gameData = gameData;
  users.set(userId, user);
  
  res.json({ success: true });
});

app.get('/api/load', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { userId } = req.query;
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const decoded = verifyToken(token, JWT_SECRET);
  if (!decoded || decoded.userId !== userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json(user.gameData || {});
});

app.post('/api/leaderboard', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { userId, userName, score, level } = req.body;
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const decoded = verifyToken(token, JWT_SECRET);
  if (!decoded || decoded.userId !== userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Обновляем или добавляем запись в таблицу лидеров
  const existingIndex = leaderboard.findIndex(entry => entry.userId === userId);
  
  if (existingIndex >= 0) {
    leaderboard[existingIndex] = { userId, userName, score, level, timestamp: Date.now() };
  } else {
    leaderboard.push({ userId, userName, score, level, timestamp: Date.now() });
  }
  
  // Сортируем по убыванию очков
  leaderboard.sort((a, b) => b.score - a.score);
  
  // Ограничиваем топ-100
  if (leaderboard.length > 100) {
    leaderboard.length = 100;
  }
  
  res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
  res.json(leaderboard.slice(0, 100)); // Возвращаем топ-100
});

app.get('/api/shop/items', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const decoded = verifyToken(token, JWT_SECRET);
  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json(shopItems);
});

// WebSocket соединения
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Проверка аутентификации
  const token = socket.handshake.auth.token;
  if (!token) {
    socket.disconnect(true);
    return;
  }
  
  const decoded = verifyToken(token, JWT_SECRET);
  if (!decoded) {
    socket.disconnect(true);
    return;
  }
  
  const userId = decoded.userId;
  socket.userId = userId;
  
  // Обработчик начала баттла
  socket.on('startBattle', () => {
    // Ищем доступного соперника
    let opponent = null;
    
    // Проверяем активные баттлы
    for (const [battleId, battle] of activeBattles) {
      if (battle.player1.userId !== userId && !battle.player2) {
        opponent = battle;
        break;
      }
    }
    
    if (opponent) {
      // Присоединяемся к существующему баттлу
      opponent.player2 = {
        userId,
        socketId: socket.id,
        score: 0,
        cps: 0
      };
      
      // Уведомляем обоих игроков
      io.to(opponent.player1.socketId).emit('battleStart', {
        opponentName: users.get(userId)?.userName || 'Соперник',
        timeLeft: 30
      });
      
      io.to(socket.id).emit('battleStart', {
        opponentName: users.get(opponent.player1.userId)?.userName || 'Соперник',
        timeLeft: 30
      });
      
      // Запускаем таймер баттла
      opponent.timer = setInterval(() => {
        opponent.timeLeft--;
        
        if (opponent.timeLeft <= 0) {
          endBattle(opponent);
        }
      }, 1000);
    } else {
      // Создаем новый баттл
      const battleId = `battle_${Date.now()}`;
      const battle = {
        battleId,
        player1: {
          userId,
          socketId: socket.id,
          score: 0,
          cps: 0
        },
        player2: null,
        timeLeft: 30,
        timer: null
      };
      
      activeBattles.set(battleId, battle);
      
      // Уведомляем игрока о начале поиска
      socket.emit('battleSearch', { message: 'Поиск соперника...' });
    }
  });
  
  // Обработчик кликов в баттле
  socket.on('battleClick', (data) => {
    const { score, cps } = data;
    
    // Находим баттл, в котором участвует игрок
    for (const [battleId, battle] of activeBattles) {
      if (battle.player1.userId === userId) {
        battle.player1.score = score;
        battle.player1.cps = cps;
        
        // Уведомляем соперника
        if (battle.player2) {
          io.to(battle.player2.socketId).emit('opponentUpdate', {
            score: battle.player1.score,
            cps: battle.player1.cps
          });
        }
        break;
      } else if (battle.player2?.userId === userId) {
        battle.player2.score = score;
        battle.player2.cps = cps;
        
        // Уведомляем соперника
        io.to(battle.player1.socketId).emit('opponentUpdate', {
          score: battle.player2.score,
          cps: battle.player2.cps
        });
        break;
      }
    }
  });
  
  // Обработчик отключения
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Завершаем все баттлы, где участвовал этот игрок
    for (const [battleId, battle] of activeBattles) {
      if (battle.player1.userId === userId || battle.player2?.userId === userId) {
        endBattle(battle);
        activeBattles.delete(battleId);
        break;
      }
    }
  });
});

// Завершение баттла
function endBattle(battle) {
  if (battle.timer) {
    clearInterval(battle.timer);
  }
  
  let winner = null;
  
  if (battle.player1 && battle.player2) {
    // Определяем победителя
    if (battle.player1.score > battle.player2.score) {
      winner = battle.player1.userId;
    } else if (battle.player2.score > battle.player1.score) {
      winner = battle.player2.userId;
    }
    
    // Уведомляем игроков
    io.to(battle.player1.socketId).emit('battleEnd', {
      winner,
      yourScore: battle.player1.score,
      opponentScore: battle.player2.score
    });
    
    io.to(battle.player2.socketId).emit('battleEnd', {
      winner,
      yourScore: battle.player2.score,
      opponentScore: battle.player1.score
    });
  } else if (battle.player1) {
    // Если соперник так и не нашелся
    io.to(battle.player1.socketId).emit('battleEnd', {
      winner: null,
      message: 'Соперник не найден'
    });
  }
}

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Очистка неактивных данных
setInterval(() => {
  const now = Date.now();
  const inactiveThreshold = 24 * 60 * 60 * 1000; // 24 часа
  
  // Удаляем неактивных пользователей
  for (const [userId, user] of users) {
    if (now - user.lastSeen > inactiveThreshold) {
      users.delete(userId);
    }
  }
  
  // Очищаем старые записи лидерборда (старше 7 дней)
  const leaderboardThreshold = 7 * 24 * 60 * 60 * 1000;
  for (let i = leaderboard.length - 1; i >= 0; i--) {
    if (now - leaderboard[i].timestamp > leaderboardThreshold) {
      leaderboard.splice(i, 1);
    }
  }
}, 60 * 60 * 1000); // Каждый час