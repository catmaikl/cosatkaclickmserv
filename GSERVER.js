require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Инициализация приложения
const app = express();
const server = http.createServer(app);

// Настройка CORS
const io = new Server(server, {
  cors: {
    origin: [
      "https://cosatka-clickgame-277.netlify.app",
      "http://127.0.0.1:5500",
      "http://localhost:5500",
    ],
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(
  cors({
    origin: [
      "https://cosatka-clickgame-277.netlify.app",
      "http://127.0.0.1:5500",
      "http://localhost:5500",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(express.json());

app.options("*", cors());

// Инициализация базы данных
const dbPath = path.join(__dirname, "database.sqlite");
const db = new sqlite3.Database(dbPath);

// Создаем таблицы при запуске
db.serialize(() => {
  // Таблица пользователей
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT,
    score INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    cps INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Таблица лидерборда
  db.run(`CREATE TABLE IF NOT EXISTS leaderboard (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    score INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    cps INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // Таблица премиум скинов пользователей
  db.run(`CREATE TABLE IF NOT EXISTS user_premium_skins (
    user_id TEXT,
    skin_id TEXT,
    obtained_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    obtained_from TEXT DEFAULT 'battle',
    PRIMARY KEY (user_id, skin_id),
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);
});

// Конфигурация
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-here";
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "your-refresh-secret-key-here";

// Премиум скины
const PREMIUM_SKINS = [
  {
    id: "skin5",
    name: "Киса (Премиум)",
    description: "Красотка!",
    type: "skin",
    effect: "theme_skin5",
    rarity: "rare", // rare, epic, legendary
    dropChance: 0.15, // 15% шанс выпадения
    price: 2500
  },
  {
    id: "skin7",
    name: "Прятки! (Премиум)",
    description: "Косатка любит прятки",
    type: "skin",
    effect: "theme_skin7",
    rarity: "epic",
    dropChance: 0.10, // 10% шанс выпадения
    price: 3500
  },
  {
    id: "skin_premium",
    name: "CYBERPUNK КОСАТКА",
    description: "Самый эксклюзивный скин",
    type: "skin",
    effect: "theme_premium",
    rarity: "legendary",
    dropChance: 0.05, // 5% шанс выпадения
    price: 5000
  },
];

// Временное хранилище данных в памяти
const users = new Map(); // userId -> userData
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
];

// Генерация токенов
function generateTokens(userId, userName) {
  const accessToken = jwt.sign({ userId, userName }, JWT_SECRET, {
    expiresIn: "15m",
  });

  const refreshToken = jwt.sign({ userId, userName }, JWT_REFRESH_SECRET, {
    expiresIn: "7d",
  });

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

// Middleware для проверки аутентификации
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const decoded = verifyToken(token, JWT_SECRET);
  if (!decoded) {
    return res.status(401).json({ error: "Invalid token" });
  }

  req.user = decoded;
  next();
}

// Функция для получения премиум скина за победу
async function grantPremiumSkinForWin(userId) {
  try {
    console.log(`Granting premium skin for win to user ${userId}`);

    // Получаем уже имеющиеся скины пользователя
    const userSkins = await new Promise((resolve, reject) => {
      db.all(
        `SELECT skin_id FROM user_premium_skins WHERE user_id = ?`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.map(row => row.skin_id));
        }
      );
    });
    
    // Фильтруем скины, которые у пользователя еще нет
    const availableSkins = PREMIUM_SKINS.filter(skin => 
      !userSkins.includes(skin.id)
    );

    if (availableSkins.length === 0) {
      console.log(`All premium skins already unlocked for user ${userId}`);
      return null;
    }

    // Взвешенный выбор по редкости
    const totalWeight = availableSkins.reduce((sum, skin) => 
      sum + (skin.dropChance * 100), 0
    );
    
    let random = Math.random() * totalWeight;
    let selectedSkin = null;

    for (const skin of availableSkins) {
      random -= skin.dropChance * 100;
      if (random <= 0) {
        selectedSkin = skin;
        break;
      }
    }

    if (!selectedSkin) {
      selectedSkin = availableSkins[0];
    }

    console.log(`Selected skin for user ${userId}: ${selectedSkin.id}`);

    // Сохраняем полученный скин в базу данных
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_premium_skins (user_id, skin_id, obtained_from) 
         VALUES (?, ?, ?)`,
        [userId, selectedSkin.id, 'battle'],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            reject(err);
          } else {
            console.log(`Skin ${selectedSkin.id} granted to user ${userId}`);
            resolve();
          }
        }
      );
    });

    return selectedSkin;
  } catch (error) {
    console.error('Error granting premium skin:', error);
    return null;
  }
}

// Функция для получения премиум скинов пользователя
function getUserPremiumSkins(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT skin_id FROM user_premium_skins WHERE user_id = ?`,
      [userId],
      (err, rows) => {
        if (err) {
          console.error('Database error in getUserPremiumSkins:', err);
          reject(err);
        } else {
          resolve(rows.map(row => row.skin_id));
        }
      }
    );
  });
}

// Добавить в GSERVER.js после существующих эндпоинтов
app.get("/api/user/premium-skins", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Получаем скины пользователя из базы данных
    const userSkins = await new Promise((resolve, reject) => {
      db.all(
        `SELECT skin_id FROM user_premium_skins WHERE user_id = ?`,
        [userId],
        (err, rows) => {
          if (err) {
            console.error('Database error:', err);
            reject(err);
          } else {
            resolve(rows.map(row => row.skin_id));
          }
        }
      );
    });

    res.json({
      success: true,
      skins: userSkins
    });
  } catch (error) {
    console.error('Error getting premium skins:', error);
    res.status(500).json({ 
      success: false,
      error: "Internal server error",
      skins: []
    });
  }
});

// В GSERVER.js
app.post("/api/user/unlock-skin", authenticateToken, async (req, res) => {
  try {
    const { skinId } = req.body;
    const userId = req.user.userId;

    console.log(`Unlocking skin ${skinId} for user ${userId}`);

    // Проверяем, существует ли такой премиум-скин
    const skinExists = PREMIUM_SKINS.some(skin => skin.id === skinId);
    if (!skinExists) {
      console.log(`Skin ${skinId} not found in premium skins list`);
      return res.status(400).json({ error: "Skin not found" });
    }

    // Проверяем, не разблокирован ли уже скин
    const userSkins = await getUserPremiumSkins(userId);
    if (userSkins.includes(skinId)) {
      console.log(`Skin ${skinId} already unlocked for user ${userId}`);
      return res.json({ 
        success: true, 
        message: "Skin already unlocked",
        alreadyUnlocked: true 
      });
    }

    // Сохраняем в базу данных
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_premium_skins (user_id, skin_id, obtained_from) 
         VALUES (?, ?, ?)`,
        [userId, skinId, 'battle'],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            reject(err);
          } else {
            console.log(`Skin ${skinId} saved for user ${userId}`);
            resolve();
          }
        }
      );
    });

    res.json({ 
      success: true,
      message: "Skin unlocked successfully"
    });
  } catch (error) {
    console.error('Error saving unlocked skin:', error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

// API Routes
app.post("/api/auth/anonymous", (req, res) => {
  const { userId, userName } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const tokens = generateTokens(userId, userName || "Anonymous");

  // Сохраняем пользователя
  if (!users.has(userId)) {
    users.set(userId, {
      userId,
      userName: userName || "Anonymous",
      refreshToken: tokens.refreshToken,
      gameData: null,
      purchasedItems: [],
      lastSeen: Date.now(),
    });
  }

  res.json(tokens);
});

app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token is required" });
  }

  const decoded = verifyToken(refreshToken, JWT_REFRESH_SECRET);
  if (!decoded) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }

  const user = users.get(decoded.userId);
  if (!user || user.refreshToken !== refreshToken) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }

  const tokens = generateTokens(decoded.userId, decoded.userName);
  user.refreshToken = tokens.refreshToken;
  users.set(decoded.userId, user);

  res.json(tokens);
});

app.post("/api/auth/verify", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ valid: false });

  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ valid: true });
  } catch {
    res.json({ valid: false });
  }
});

app.post("/api/save", authenticateToken, (req, res) => {
  const { userId, gameData } = req.body;

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  user.gameData = gameData;
  users.set(userId, user);

  res.json({ success: true });
});

app.get("/api/load", authenticateToken, (req, res) => {
  const { userId } = req.query;

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json(user.gameData || {});
});

// Shop purchase endpoint
app.post("/api/shop/purchase", authenticateToken, (req, res) => {
  const { itemId } = req.body;
  const userId = req.user.userId;

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Находим предмет
  const item = shopItems.find((i) => i.id === itemId);
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }

  // Проверяем валюту пользователя
  if (!user.gameData || !user.gameData.shop || user.gameData.shop.currency < item.price) {
    return res.status(400).json({ error: "Not enough currency" });
  }

  // Вычитаем цену
  user.gameData.shop.currency -= item.price;

  // Если это скин, добавляем его в доступные скины пользователя
  if (item.type === "skin") {
    if (!user.gameData.settings.availableSkins) {
      user.gameData.settings.availableSkins = [];
    }
    if (!user.gameData.settings.availableSkins.includes(itemId)) {
      user.gameData.settings.availableSkins.push(itemId);
    }
  }

  // Обновляем данные пользователя
  users.set(userId, user);

  res.json({
    success: true,
    currency: user.gameData.shop.currency,
    // Убрали purchased: true, чтобы можно было покупать снова
  });
});

// Get user shop data
app.get("/api/shop/user", authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const user = users.get(userId);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    currency: user.gameData?.shop?.currency || 0,
    purchasedItems: user.purchasedItems || [],
  });
});

app.post("/api/leaderboard", authenticateToken, (req, res) => {
  const { userId, userName, score, level, cps } = req.body;

  // Обновляем или добавляем пользователя в таблицу users
  db.run(
    `INSERT OR REPLACE INTO users (id, username, score, level, cps, last_updated)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [userId, userName, score, level, cps || 0],
    function(err) {
      if (err) {
        console.error("Error saving user:", err);
        return res.status(500).json({ error: "Database error" });
      }

      // Обновляем лидерборд - вставляем или обновляем запись
      db.run(
        `INSERT OR REPLACE INTO leaderboard (user_id, username, score, level, cps, last_updated)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [userId, userName, score, level, cps || 0],
        function(err) {
          if (err) {
            console.error("Error updating leaderboard:", err);
            return res.status(500).json({ error: "Database error" });
          }

          res.json({ success: true });
        }
      );
    }
  );
});

app.get("/api/leaderboard", (req, res) => {
  // Получаем данные из базы данных, а не из памяти
  db.all(`
    SELECT user_id as userId, username as userName, score, level, cps 
    FROM leaderboard 
    ORDER BY score DESC 
    LIMIT 100
  `, (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

app.get("/api/user/stats", authenticateToken, (req, res) => {
  const userId = req.user.userId;

  db.get(
    `
    SELECT score, level, cps, last_updated 
    FROM users 
    WHERE id = ?
  `,
    [userId],
    (err, row) => {
      if (err) {
        console.error("Database error:", err);
        return res.status(500).json({ error: "Database error" });
      }

      if (row) {
        res.json(row);
      } else {
        res.status(404).json({ error: "User not found" });
      }
    }
  );
});

app.get("/api/shop/items", authenticateToken, (req, res) => {
  res.json(shopItems);
});

// WebSocket соединения
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

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
  const userName = decoded.userName || "Anonymous";
  socket.userId = userId;
  socket.userName = userName;

  // Обработчик начала баттла
  socket.on("startBattle", () => {
    console.log("Battle search started by:", userId);

    // Ищем доступного соперника
    let availableBattle = null;

    for (const [battleId, battle] of activeBattles) {
      if (battle.player2 === null && battle.player1.userId !== userId) {
        availableBattle = battle;
        break;
      }
    }

    if (availableBattle) {
      // Присоединяемся к существующему баттлу
      availableBattle.player2 = {
        userId: userId,
        socketId: socket.id,
        userName: userName,
        score: 0,
        cps: 0,
        clicks: [],
      };

      // Уведомляем обоих игроков о начале баттла
      io.to(availableBattle.player1.socketId).emit("battleStart", {
        opponentName: userName,
        timeLeft: 30,
      });

      io.to(socket.id).emit("battleStart", {
        opponentName: availableBattle.player1.userName,
        timeLeft: 30,
      });

      // Запускаем таймер баттла
      availableBattle.timeLeft = 30;
      availableBattle.timer = setInterval(() => {
        availableBattle.timeLeft--;

        // Отправляем обновление времени обоим игрокам
        io.to(availableBattle.player1.socketId).emit("battleTimeUpdate", {
          timeLeft: availableBattle.timeLeft,
        });
        io.to(socket.id).emit("battleTimeUpdate", {
          timeLeft: availableBattle.timeLeft,
        });

        if (availableBattle.timeLeft <= 0) {
          endBattle(availableBattle);
        }
      }, 1000);
    } else {
      // Создаем новый баттл и ждем соперника
      const battleId = `battle_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      const battle = {
        battleId,
        player1: {
          userId: userId,
          socketId: socket.id,
          userName: userName,
          score: 0,
          cps: 0,
          clicks: [],
        },
        player2: null,
        timeLeft: 30,
        timer: null,
        createdAt: Date.now(),
      };

      activeBattles.set(battleId, battle);

      // Уведомляем игрока о начале поиска
      socket.emit("battleSearch", {
        message: "Поиск соперника...",
        battleId: battleId,
      });

      // Автоматически удаляем баттл если за 30 секунд не нашелся соперник
      setTimeout(() => {
        if (
          activeBattles.has(battleId) &&
          activeBattles.get(battleId).player2 === null
        ) {
          socket.emit("battleEnd", {
            winner: null,
            message: "Соперник не найден",
          });
          activeBattles.delete(battleId);
        }
      }, 30000);
    }
  });

  // Обработчик кликов в баттле
  socket.on("battleClick", (data) => {
    const { score, cps } = data;

    // Находим баттл игрока
    for (const [battleId, battle] of activeBattles) {
      if (battle.player1.userId === userId) {
        battle.player1.score = score;
        battle.player1.cps = cps;
        battle.player1.clicks.push(Date.now());

        // Фильтруем клики старше 1 секунды
        battle.player1.clicks = battle.player1.clicks.filter(
          (time) => Date.now() - time < 1000
        );
        battle.player1.cps = battle.player1.clicks.length;

        if (battle.player2) {
          io.to(battle.player2.socketId).emit("opponentUpdate", {
            score: battle.player1.score,
            cps: battle.player1.cps,
          });
        }
        break;
      } else if (battle.player2 && battle.player2.userId === userId) {
        battle.player2.score = score;
        battle.player2.cps = cps;
        battle.player2.clicks.push(Date.now());

        // Фильтруем клики старше 1 секунды
        battle.player2.clicks = battle.player2.clicks.filter(
          (time) => Date.now() - time < 1000
        );
        battle.player2.cps = battle.player2.clicks.length;

        io.to(battle.player1.socketId).emit("opponentUpdate", {
          score: battle.player2.score,
          cps: battle.player2.cps,
        });
        break;
      }
    }
  });

  // Обработчик отключения
  socket.on("disconnect", (reason) => {
    console.log("Client disconnected:", socket.id, reason);

    // Завершаем все баттлы где участвовал этот игрок
    for (const [battleId, battle] of activeBattles) {
      if (
        battle.player1.userId === userId ||
        (battle.player2 && battle.player2.userId === userId)
      ) {
        endBattle(battle);
        activeBattles.delete(battleId);
      }
    }
  });
});

// Завершение баттла
async function endBattle(battle) {
  if (battle.timer) {
    clearInterval(battle.timer);
  }

  let winner = null;
  let winnerSocketId = null;
  let loserSocketId = null;

  if (battle.player1 && battle.player2) {
    // Определяем победителя
    if (battle.player1.score > battle.player2.score) {
      winner = battle.player1.userId;
      winnerSocketId = battle.player1.socketId;
      loserSocketId = battle.player2.socketId;
    } else if (battle.player2.score > battle.player1.score) {
      winner = battle.player2.userId;
      winnerSocketId = battle.player2.socketId;
      loserSocketId = battle.player1.socketId;
    }

    // Проверяем шанс выпадения премиум скина для победителя
    let skinReward = null;
    if (winner && Math.random() < 0.15) { // 15% общий шанс на получение скина
      skinReward = await grantPremiumSkinForWin(winner);
    }

    // Уведомляем игроков
    const battleResult = {
      winner,
      yourScore: battle.player1.score,
      opponentScore: battle.player2.score,
      skinReward: skinReward ? {
        id: skinReward.id,
        name: skinReward.name,
        rarity: skinReward.rarity
      } : null
    };

    io.to(battle.player1.socketId).emit("battleEnd", {
      ...battleResult,
      yourScore: battle.player1.score,
      opponentScore: battle.player2.score,
      isWinner: battle.player1.userId === winner
    });

    io.to(battle.player2.socketId).emit("battleEnd", {
      ...battleResult,
      yourScore: battle.player2.score,
      opponentScore: battle.player1.score,
      isWinner: battle.player2.userId === winner
    });

    // Обновляем статистику в базе данных
    try {
      // Для победителя
      if (winner) {
        db.run(
          `UPDATE users SET score = score + ? WHERE id = ?`,
          [battle.player1.userId === winner ? battle.player1.score : battle.player2.score, winner]
        );
      }
    } catch (error) {
      console.error('Error updating battle stats:', error);
    }
  } else if (battle.player1) {
    // Если соперник так и не нашелся
    io.to(battle.player1.socketId).emit("battleEnd", {
      winner: null,
      message: "Соперник не найден",
    });
  }

  // Удаляем баттл из активных
  activeBattles.delete(battle.battleId);
}

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Очистка старых записей лидерборда (раз в день)
setInterval(() => {
  db.run(`DELETE FROM leaderboard 
          WHERE last_updated < datetime('now', '-30 days')`, 
          (err) => {
    if (err) {
      console.error('Error cleaning leaderboard:', err);
    } else {
      console.log('Leaderboard cleaned: removed old entries');
    }
  });
}, 24 * 60 * 60 * 1000);