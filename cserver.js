const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Настройка CORS
const corsOptions = {
  origin: ['https://cosatka-clickgame-277.netlify.app', 'https://cosatkaclickmserv-1.onrender.com', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// Хранилище данных
const users = {}; // {username: {ws, online, lastSeen, level, score}}
const friendships = {
  requests: [], // {from, to, id, timestamp}
  friends: {} // {username: [friend1, friend2]}
};
const chatMessages = {
  global: [], // {sender, message, timestamp}
  private: {} // {chatId: [messages]}
};

// WebSocket сервер для друзей и чата
const wss = new WebSocket.Server({ server, path: '/friends' });
const chatWss = new WebSocket.Server({ server, path: '/chat' });

// Добавьте этот endpoint в cserver.js (рядом с другими API endpoints)
app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  
  if (!users[username]) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  res.json({
    username,
    level: users[username].level || 1,
    score: users[username].score || 0,
    online: users[username].online || false
  });
});

// API endpoints
app.get('/api/friends/:username', (req, res) => {
  const { username } = req.params;
  
  res.json({
    friends: friendships.friends[username] || [],
    incomingRequests: friendships.requests.filter(r => r.to === username),
    outgoingRequests: friendships.requests.filter(r => r.from === username)
  });
});

app.post('/api/friends/request', (req, res) => {
  const { from, to } = req.body;
  
  if (!from || !to) {
    return res.status(400).json({ error: 'Необходимо указать отправителя и получателя' });
  }
  
  if (!users[from] || !users[to]) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  if (friendships.requests.some(r => r.from === from && r.to === to)) {
    return res.status(400).json({ error: 'Запрос уже отправлен' });
  }
  
  const requestId = uuid.v4();
  const request = { from, to, id: requestId, timestamp: Date.now() };
  friendships.requests.push(request);
  
  // Уведомление получателя, если онлайн
  if (users[to] && users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'friend_request',
      request
    }));
  }
  
  res.json({ success: true, requestId });
});

app.post('/api/friends/accept', (req, res) => {
  const { requestId } = req.body;
  const request = friendships.requests.find(r => r.id === requestId);
  
  if (!request) {
    return res.status(404).json({ error: 'Запрос не найден' });
  }
  
  // Добавляем в друзья
  if (!friendships.friends[request.from]) friendships.friends[request.from] = [];
  if (!friendships.friends[request.to]) friendships.friends[request.to] = [];
  
  friendships.friends[request.from].push(request.to);
  friendships.friends[request.to].push(request.from);
  
  // Удаляем запрос
  friendships.requests = friendships.requests.filter(r => r.id !== requestId);
  
  // Уведомляем обоих пользователей
  [request.from, request.to].forEach(username => {
    if (users[username] && users[username].ws) {
      users[username].ws.send(JSON.stringify({
        type: 'friend_added',
        friend: username === request.from ? request.to : request.from
      }));
    }
  });
  
  res.json({ success: true });
});

app.post('/api/friends/reject', (req, res) => {
  const { requestId } = req.body;
  const request = friendships.requests.find(r => r.id === requestId);
  
  if (!request) {
    return res.status(404).json({ error: 'Запрос не найден' });
  }
  
  friendships.requests = friendships.requests.filter(r => r.id !== requestId);
  
  // Уведомляем отправителя
  if (users[request.from] && users[request.from].ws) {
    users[request.from].ws.send(JSON.stringify({
      type: 'friend_request_rejected',
      to: request.to
    }));
  }
  
  res.json({ success: true });
});

app.post('/api/friends/remove', (req, res) => {
  const { username, friend } = req.body;
  
  if (!friendships.friends[username] || !friendships.friends[friend]) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  friendships.friends[username] = friendships.friends[username].filter(f => f !== friend);
  friendships.friends[friend] = friendships.friends[friend].filter(f => f !== username);
  
  // Уведомляем обоих пользователей
  [username, friend].forEach(u => {
    if (users[u] && users[u].ws) {
      users[u].ws.send(JSON.stringify({
        type: 'friend_removed',
        friend: u === username ? friend : username
      }));
    }
  });
  
  res.json({ success: true });
});

// WebSocket для системы друзей
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const username = params.get('username');
  
  if (!username) {
    ws.close();
    return;
  }
  
  // Регистрируем пользователя
  users[username] = {
    ws,
    online: true,
    lastSeen: Date.now(),
    level: parseInt(params.get('level')) || 1,
    score: parseInt(params.get('score')) || 0
  };
  
  // Отправляем начальные данные
  ws.send(JSON.stringify({
    type: 'initial_data',
    friends: friendships.friends[username] || [],
    requests: {
      incoming: friendships.requests.filter(r => r.to === username),
      outgoing: friendships.requests.filter(r => r.from === username)
    },
    onlineStatus: getOnlineStatus(friendships.friends[username] || [])
  }));
  
  // Уведомляем друзей о подключении
  notifyFriends(username, true);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'friend_request':
          handleFriendRequest(ws, username, data.to);
          break;
        case 'accept_request':
          handleAcceptRequest(ws, username, data.requestId);
          break;
        case 'reject_request':
          handleRejectRequest(ws, username, data.requestId);
          break;
        case 'remove_friend':
          handleRemoveFriend(ws, username, data.friend);
          break;
        case 'search_users':
          handleSearchUsers(ws, username, data.query);
          break;
        case 'battle_invite':
          handleBattleInvite(ws, username, data.to, data.battleId);
          break;
      }
    } catch (e) {
      console.error('Ошибка обработки сообщения:', e);
    }
  });
  
  ws.on('close', () => {
    if (users[username]) {
      users[username].online = false;
      users[username].lastSeen = Date.now();
      notifyFriends(username, false);
    }
  });
});

// WebSocket для чата
chatWss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const username = params.get('username');
  
  if (!username) {
    ws.close();
    return;
  }
  
  // Регистрируем соединение чата
  if (!users[username]) users[username] = {};
  users[username].chatWs = ws;
  
  // Приветственное сообщение
  ws.send(JSON.stringify({
    type: 'system_message',
    message: 'Добро пожаловать в чат!'
  }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'chat_message':
          handleChatMessage(username, data.message, data.recipient);
          break;
        case 'get_history':
          handleGetChatHistory(ws, username, data.recipient, data.limit);
          break;
      }
    } catch (e) {
      console.error('Ошибка обработки сообщения чата:', e);
    }
  });
  
  ws.on('close', () => {
    if (users[username]) {
      delete users[username].chatWs;
    }
  });
});

// Функции обработчики
function handleFriendRequest(ws, from, to) {
  if (!users[to]) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Пользователь не найден'
    }));
    return;
  }
  
  if (friendships.requests.some(r => r.from === from && r.to === to)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Запрос уже отправлен'
    }));
    return;
  }
  
  const requestId = uuid.v4();
  const request = { from, to, id: requestId, timestamp: Date.now() };
  friendships.requests.push(request);
  
  // Уведомление получателя
  if (users[to] && users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'friend_request',
      request
    }));
  }
  
  ws.send(JSON.stringify({
    type: 'friend_request_sent',
    requestId
  }));
}

function handleAcceptRequest(ws, username, requestId) {
  const request = friendships.requests.find(r => r.id === requestId && r.to === username);
  
  if (!request) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Запрос не найден'
    }));
    return;
  }
  
  // Добавляем в друзья
  if (!friendships.friends[request.from]) friendships.friends[request.from] = [];
  if (!friendships.friends[request.to]) friendships.friends[request.to] = [];
  
  friendships.friends[request.from].push(request.to);
  friendships.friends[request.to].push(request.from);
  
  // Удаляем запрос
  friendships.requests = friendships.requests.filter(r => r.id !== requestId);
  
  // Уведомляем обоих пользователей
  [request.from, request.to].forEach(u => {
    if (users[u] && users[u].ws) {
      users[u].ws.send(JSON.stringify({
        type: 'friend_added',
        friend: u === request.from ? request.to : request.from
      }));
    }
  });
}

function handleRejectRequest(ws, username, requestId) {
  const request = friendships.requests.find(r => r.id === requestId && r.to === username);
  
  if (!request) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Запрос не найден'
    }));
    return;
  }
  
  friendships.requests = friendships.requests.filter(r => r.id !== requestId);
  
  // Уведомляем отправителя
  if (users[request.from] && users[request.from].ws) {
    users[request.from].ws.send(JSON.stringify({
      type: 'friend_request_rejected',
      to: username
    }));
  }
}

function handleRemoveFriend(ws, username, friend) {
  if (!friendships.friends[username] || !friendships.friends[friend]) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Пользователь не найден'
    }));
    return;
  }
  
  friendships.friends[username] = friendships.friends[username].filter(f => f !== friend);
  friendships.friends[friend] = friendships.friends[friend].filter(f => f !== username);
  
  // Уведомляем обоих пользователей
  [username, friend].forEach(u => {
    if (users[u] && users[u].ws) {
      users[u].ws.send(JSON.stringify({
        type: 'friend_removed',
        friend: u === username ? friend : username
      }));
    }
  });
}

function handleSearchUsers(ws, username, query) {
  if (!query || query.length < 3) {
    ws.send(JSON.stringify({
      type: 'search_results',
      results: []
    }));
    return;
  }
  
  const results = Object.keys(users)
    .filter(u => 
      u.toLowerCase().includes(query.toLowerCase()) && 
      u !== username &&
      !friendships.friends[username]?.includes(u)
    )
    .map(u => ({
      username: u,
      online: users[u]?.online || false,
      level: users[u]?.level || 1
    }));
  
  ws.send(JSON.stringify({
    type: 'search_results',
    results
  }));
}

function handleBattleInvite(ws, from, to, battleId) {
  if (!users[to]) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Пользователь не найден'
    }));
    return;
  }
  
  if (!users[to].online) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Пользователь оффлайн'
    }));
    return;
  }
  
  if (users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'battle_invite',
      from,
      battleId
    }));
  }
}

function handleChatMessage(sender, message, recipient) {
  const timestamp = Date.now();
  
  if (recipient) {
    // Приватное сообщение
    const chatId = [sender, recipient].sort().join('_');
    if (!chatMessages.private[chatId]) {
      chatMessages.private[chatId] = [];
    }
    
    const msg = {
      sender,
      recipient,
      message,
      timestamp,
      isPrivate: true
    };
    
    chatMessages.private[chatId].push(msg);
    
    // Отправляем получателю
    if (users[recipient] && users[recipient].chatWs) {
      users[recipient].chatWs.send(JSON.stringify({
        type: 'chat_message',
        ...msg,
        isOwn: false
      }));
    }
    
    // Отправляем отправителю
    if (users[sender] && users[sender].chatWs) {
      users[sender].chatWs.send(JSON.stringify({
        type: 'chat_message',
        ...msg,
        isOwn: true
      }));
    }
  } else {
    // Глобальное сообщение
    const msg = {
      sender,
      message,
      timestamp,
      isPrivate: false
    };
    
    chatMessages.global.push(msg);
    
    // Рассылаем всем в чате
    Object.values(users).forEach(user => {
      if (user.chatWs) {
        user.chatWs.send(JSON.stringify({
          type: 'chat_message',
          ...msg,
          isOwn: user === users[sender]
        }));
      }
    });
  }
}

function handleGetChatHistory(ws, username, recipient, limit = 50) {
  if (recipient) {
    // История приватного чата
    const chatId = [username, recipient].sort().join('_');
    const messages = (chatMessages.private[chatId] || []).slice(-limit);
    
    ws.send(JSON.stringify({
      type: 'chat_history',
      messages,
      recipient
    }));
  } else {
    // История глобального чата
    ws.send(JSON.stringify({
      type: 'chat_history',
      messages: chatMessages.global.slice(-limit)
    }));
  }
}

// Вспомогательные функции
function notifyFriends(username, isOnline) {
  const friends = friendships.friends[username] || [];
  
  friends.forEach(friend => {
    if (users[friend] && users[friend].ws) {
      users[friend].ws.send(JSON.stringify({
        type: isOnline ? 'friend_online' : 'friend_offline',
        friend: username
      }));
    }
  });
}

function getOnlineStatus(friends) {
  const status = {};
  friends.forEach(friend => {
    status[friend] = users[friend]?.online || false;
  });
  return status;
}

// Запуск сервера
server.listen(10000, () => {
  console.log('Сервер запущен на порту 10000');
});