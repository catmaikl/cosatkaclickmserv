// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Модели данных
const User = mongoose.model('User', new mongoose.Schema({
  username: String,
  passwordHash: String,
  salt: String,
  avatar: String,
  level: { type: Number, default: 1 },
  score: { type: Number, default: 0 },
  battles: { type: Number, default: 0 }
}));

const Friend = mongoose.model('Friend', new mongoose.Schema({
  user1: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  user2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  text: String,
  type: { type: String, enum: ['text', 'bonus', 'challenge'], default: 'text' },
  amount: Number,
  challengeId: String,
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

const Group = mongoose.model('Group', new mongoose.Schema({
  name: String,
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  avatar: String,
  createdAt: { type: Date, default: Date.now }
}));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());

// Генерация JWT токена
function generateToken(user) {
  return jwt.sign(
    { userId: user._id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Аутентификация
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.sendStatus(401);
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Хеширование пароля
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

// API endpoints
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    
    const user = new User({
      username,
      passwordHash,
      salt
    });
    
    await user.save();
    
    const token = generateToken(user);
    res.json({ token, userId: user._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const hash = hashPassword(password, user.salt);
    if (hash !== user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user);
    res.json({ token, userId: user._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.query.userId || req.user.userId;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Проверяем, является ли пользователь другом
    const isFriend = await Friend.findOne({
      $or: [
        { user1: req.user.userId, user2: userId, status: 'accepted' },
        { user1: userId, user2: req.user.userId, status: 'accepted' }
      ]
    });
    
    res.json({
      success: true,
      profile: {
        name: user.username,
        avatar: user.avatar,
        level: user.level,
        score: user.score,
        battles: user.battles
      },
      isFriend: !!isFriend
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Другие API endpoints (friends, messages, groups) можно реализовать аналогично

// WebSocket соединения
const clients = new Map();

wss.on('connection', (ws, req) => {
  // Аутентификация через токен в query параметрах
  const token = req.url.split('token=')[1];
  if (!token) {
    ws.close();
    return;
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      ws.close();
      return;
    }
    
    // Сохраняем соединение
    clients.set(user.userId, ws);
    console.log(`User connected: ${user.username}`);
    
    // Отправляем уведомление о подключении
    ws.send(JSON.stringify({
      type: 'notification',
      text: 'Вы подключены к чату'
    }));
    
    // Обработка сообщений
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        
        switch(data.type) {
          case 'private_message':
            await handlePrivateMessage(data, user);
            break;
          case 'group_message':
            await handleGroupMessage(data, user);
            break;
          case 'game_bonus':
            await handleGameBonus(data, user);
            break;
          case 'game_challenge':
            await handleGameChallenge(data, user);
            break;
          case 'accept_challenge':
            await handleAcceptChallenge(data, user);
            break;
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });
    
    // Обработка закрытия соединения
    ws.on('close', () => {
      clients.delete(user.userId);
      console.log(`User disconnected: ${user.username}`);
    });
  });
});

async function handlePrivateMessage(data, sender) {
  // Сохраняем сообщение в БД
  const message = new Message({
    sender: sender.userId,
    recipient: data.recipientId,
    text: data.text,
    createdAt: data.timestamp
  });
  
  await message.save();
  
  // Отправляем сообщение получателю, если он онлайн
  const recipientWs = clients.get(data.recipientId);
  if (recipientWs) {
    recipientWs.send(JSON.stringify({
      type: 'private_message',
      senderId: sender.userId,
      senderName: sender.username,
      text: data.text,
      timestamp: data.timestamp
    }));
  }
  
  // Можно также реализовать push-уведомления для оффлайн пользователей
}

async function handleGameBonus(data, sender) {
  // Проверяем, что у отправителя достаточно средств
  const senderUser = await User.findById(sender.userId);
  if (senderUser.score < data.amount) {
    clients.get(sender.userId)?.send(JSON.stringify({
      type: 'notification',
      text: 'Недостаточно косаток для отправки бонуса'
    }));
    return;
  }
  
  // Вычитаем бонус у отправителя
  senderUser.score -= data.amount;
  await senderUser.save();
  
  // Добавляем бонус получателю
  await User.findByIdAndUpdate(data.recipientId, {
    $inc: { score: data.amount }
  });
  
  // Сохраняем сообщение о бонусе
  const message = new Message({
    sender: sender.userId,
    recipient: data.recipientId,
    type: 'bonus',
    amount: data.amount,
    createdAt: data.timestamp
  });
  
  await message.save();
  
  // Отправляем уведомление получателю
  const recipientWs = clients.get(data.recipientId);
  if (recipientWs) {
    recipientWs.send(JSON.stringify({
      type: 'game_bonus',
      senderId: sender.userId,
      senderName: sender.username,
      amount: data.amount,
      timestamp: data.timestamp
    }));
  }
  
  // Отправляем подтверждение отправителю
  clients.get(sender.userId)?.send(JSON.stringify({
    type: 'notification',
    text: `Бонус отправлен!`
  }));
}

async function handleGameChallenge(data, sender) {
  // Сохраняем вызов в БД
  const message = new Message({
    sender: sender.userId,
    recipient: data.recipientId,
    type: 'challenge',
    challengeId: data.challengeId,
    createdAt: data.timestamp
  });
  
  await message.save();
  
  // Отправляем вызов получателю
  const recipientWs = clients.get(data.recipientId);
  if (recipientWs) {
    recipientWs.send(JSON.stringify({
      type: 'game_challenge',
      senderId: sender.userId,
      senderName: sender.username,
      challengeId: data.challengeId,
      timestamp: data.timestamp
    }));
  }
}

async function handleAcceptChallenge(data, sender) {
  // Здесь можно реализовать логику начала баттла
  // Например, создать комнату баттла и уведомить обоих игроков
  
  // Получаем информацию о вызове
  const challenge = await Message.findOne({
    challengeId: data.challengeId,
    type: 'challenge'
  });
  
  if (!challenge) {
    clients.get(sender.userId)?.send(JSON.stringify({
      type: 'notification',
      text: 'Вызов не найден'
    }));
    return;
  }
  
  // Уведомляем обоих игроков
  clients.get(sender.userId)?.send(JSON.stringify({
    type: 'battle_start',
    battleId: 'battle-' + Date.now(),
    opponentId: challenge.sender,
    opponentName: challenge.senderName
  }));
  
  clients.get(challenge.sender)?.send(JSON.stringify({
    type: 'battle_start',
    battleId: 'battle-' + Date.now(),
    opponentId: sender.userId,
    opponentName: sender.username
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});