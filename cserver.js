// server.js

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');
const cors = require('cors');
const path = require('path'); // Added path module
const { pathToRegexp } = require('path-to-regexp');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const battleServer = new WebSocket.Server({ port: 8081 });
const chatServer = new WebSocket.Server({ port: 8082 });

// Enhanced CORS configuration
const corsOptions = {
  origin: ['https://cosatka-clickgame-277.netlify.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Added URL-encoded parser

// In-memory databases
const users = {};
const friendships = {
  requests: [],
  friends: {}
};
const chatMessages = {
  global: [],
  private: {}
};

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message
  });
});

// HTTP API endpoints
app.post('/api/friends/request', (req, res) => {
  const { from, to } = req.body;

  // Валидация входных данных
  if (!from || !to) {
    return res.status(400).json({
      error: 'Необходимо указать отправителя и получателя'
    });
  }

  // Проверка существования пользователей
  if (!users[from] || !users[to]) {
    return res.status(404).json({
      error: 'User not found',
      username: !users[from] ? from : to
    });
  }

  // Проверка существующего запроса
  if (friendships.requests.some(r => r.from === from && r.to === to)) {
    return res.status(400).json({
      error: 'Request already sent'
    });
  }

  const requestId = uuid.v4();
  friendships.requests.push({ from, to, id: requestId });

  // Уведомление получателя, если онлайн
  if (users[to] && users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'friend_request',
      from,
      requestId
    }));
  }

  res.json({ success: true, requestId });
});

app.post('/api/friends/accept', (req, res) => {
  const { requestId } = req.body;
  const request = friendships.requests.find(r => r.id === requestId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  // Add to friends list
  if (!friendships.friends[request.from]) friendships.friends[request.from] = [];
  if (!friendships.friends[request.to]) friendships.friends[request.to] = [];

  friendships.friends[request.from].push(request.to);
  friendships.friends[request.to].push(request.from);

  // Remove request
  friendships.requests = friendships.requests.filter(r => r.id !== requestId);

  // Notify both users
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
    return res.status(404).json({ error: 'Request not found' });
  }

  friendships.requests = friendships.requests.filter(r => r.id !== requestId);

  // Notify sender
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
    return res.status(404).json({ error: 'User not found' });
  }

  friendships.friends[username] = friendships.friends[username].filter(f => f !== friend);
  friendships.friends[friend] = friendships.friends[friend].filter(f => f !== username);

  // Notify both users
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

app.get('/api/friends/:username(\\w+)', (req, res) => {  // Added regex constraint
  const { username } = req.params;

  res.json({
    friends: friendships.friends[username] || [],
    incomingRequests: friendships.requests.filter(r => r.to === username),
    outgoingRequests: friendships.requests.filter(r => r.from === username)
  });
});

app.get('/api/chat/history', (req, res) => {
  const { username, recipient, limit = 50 } = req.query;

  if (recipient) {
    // Private chat
    const chatId = [username, recipient].sort().join('_');
    if (!chatMessages.private[chatId]) {
      chatMessages.private[chatId] = [];
    }
    res.json(chatMessages.private[chatId].slice(-limit));
  } else {
    // Global chat
    res.json(chatMessages.global.slice(-limit));
  }
});

// Friends WebSocket
wss.on('connection', (ws, req) => {
  let username;
  try {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    username = urlParams.get('username');
  } catch (e) {
    ws.close();
    return;
  }

  if (!username) {
    ws.close();
    return;
  }

  // Register user
  users[username] = { ws, online: true, lastSeen: Date.now() };

  // Send initial data
  ws.send(JSON.stringify({
    type: 'initial_data',
    friends: friendships.friends[username] || [],
    requests: {
      incoming: friendships.requests.filter(r => r.to === username),
      outgoing: friendships.requests.filter(r => r.from === username)
    }
  }));

  // Notify friends about online status
  (friendships.friends[username] || []).forEach(friend => {
    if (users[friend] && users[friend].ws) {
      users[friend].ws.send(JSON.stringify({
        type: 'friend_online',
        friend: username
      }));
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'friend_request':
          handleFriendRequest(ws, username, data);
          break;

        case 'accept_request':
          handleAcceptRequest(ws, username, data);
          break;

        case 'reject_request':
          handleRejectRequest(ws, username, data);
          break;

        case 'remove_friend':
          handleRemoveFriend(ws, username, data);
          break;

        case 'get_online_status':
          handleGetOnlineStatus(ws, username, data);
          break;

        case 'search_users':
          handleSearchUsers(ws, username, data);
          break;

        case 'battle_invite':
          handleBattleInvite(ws, username, data);
          break;
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    if (users[username]) {
      users[username].online = false;
      users[username].lastSeen = Date.now();

      // Notify friends
      (friendships.friends[username] || []).forEach(friend => {
        if (users[friend] && users[friend].ws) {
          users[friend].ws.send(JSON.stringify({
            type: 'friend_offline',
            friend: username
          }));
        }
      });
    }
  });
});

// Chat WebSocket
chatServer.on('connection', (ws, req) => {
  let username;
  try {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    username = urlParams.get('username');
  } catch (e) {
    ws.close();
    return;
  }

  if (!username) {
    ws.close();
    return;
  }

  // Register user
  if (!users[username]) {
    users[username] = {};
  }
  users[username].chatWs = ws;

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'system_message',
    message: 'Добро пожаловать в чат!'
  }));

  // Notify others
  broadcastSystemMessage(`${username} присоединился к чату`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'chat_message':
          handleChatMessage(username, data);
          break;

        case 'get_history':
          handleGetChatHistory(ws, username, data);
          break;
        case "search_results":
          if (data.error) {
            showNotification("Ошибка поиска: " + data.error);
          } else {
            displaySearchResults(data.results);
          }
          break;
      }
    } catch (e) {
      console.error('Error processing chat message:', e);
    }
  });

  ws.on('close', () => {
    if (users[username]) {
      delete users[username].chatWs;
      broadcastSystemMessage(`${username} покинул чат`);
    }
  });
});

// Battle WebSocket (existing code remains the same)
battleServer.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const battleId = urlParams.get('battleId');
  const username = urlParams.get('username');

  if (!battleId || !username) {
    ws.close();
    return;
  }

  // Existing battle logic...
});

// Helper functions
function handleFriendRequest(ws, username, data) {
  const { to } = data;

  if (!users[to]) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'User not found',
      username: to  // Use the actual variable
    }));
    return;
  }

  if (friendships.requests.some(r => r.from === username && r.to === to)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Request already sent'
    }));
    return;
  }

  const requestId = uuid.v4();
  friendships.requests.push({ from: username, to, id: requestId });

  // Notify recipient
  if (users[to] && users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'friend_request',
      from: username,
      requestId
    }));
  }

  ws.send(JSON.stringify({
    type: 'friend_request_sent',
    to,
    requestId
  }));
}

function handleAcceptRequest(ws, username, data) {
  const { from } = data;
  const request = friendships.requests.find(r => r.from === from && r.to === username);

  if (!request) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Request not found'
    }));
    return;
  }

  // Add to friends list
  if (!friendships.friends[username]) friendships.friends[username] = [];
  if (!friendships.friends[from]) friendships.friends[from] = [];

  friendships.friends[username].push(from);
  friendships.friends[from].push(username);

  // Remove request
  friendships.requests = friendships.requests.filter(r => r.id !== request.id);

  // Notify both users
  [username, from].forEach(u => {
    if (users[u] && users[u].ws) {
      users[u].ws.send(JSON.stringify({
        type: 'friend_added',
        friend: u === username ? from : username
      }));
    }
  });
}

function handleRejectRequest(ws, username, data) {
  const { from } = data;
  const request = friendships.requests.find(r => r.from === from && r.to === username);

  if (!request) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Request not found'
    }));
    return;
  }

  friendships.requests = friendships.requests.filter(r => r.id !== request.id);

  // Notify sender
  if (users[from] && users[from].ws) {
    users[from].ws.send(JSON.stringify({
      type: 'friend_request_rejected',
      to: username
    }));
  }

  ws.send(JSON.stringify({
    type: 'friend_request_rejected',
    from
  }));
}

function handleRemoveFriend(ws, username, data) {
  const { friend } = data;

  if (!friendships.friends[username] || !friendships.friends[friend]) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'User not found'
    }));
    return;
  }

  friendships.friends[username] = friendships.friends[username].filter(f => f !== friend);
  friendships.friends[friend] = friendships.friends[friend].filter(f => f !== username);

  // Notify both users
  [username, friend].forEach(u => {
    if (users[u] && users[u].ws) {
      users[u].ws.send(JSON.stringify({
        type: 'friend_removed',
        friend: u === username ? friend : username
      }));
    }
  });
}

function handleGetOnlineStatus(ws, username, data) {
  const { friends } = data;
  const status = {};

  friends.forEach(friend => {
    status[friend] = users[friend] ? users[friend].online : false;
  });

  ws.send(JSON.stringify({
    type: 'online_status',
    status
  }));
}

function handleSearchUsers(ws, username, data) {
  const { query } = data;
  const results = [];

  // Simple search - in a real app you'd use a database
  Object.keys(users).forEach(user => {
    if (user.toLowerCase().includes(query.toLowerCase()) &&
      user !== username &&
      !friendships.friends[username]?.includes(user)) {
      results.push({
        username: user,
        online: users[user]?.online || false
      });
    }
  });

  ws.send(JSON.stringify({
    type: 'search_results',
    results
  }));
}

function handleBattleInvite(ws, username, data) {
  const { to, battleId } = data;

  if (!users[to]) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'User not found'
    }));
    return;
  }

  if (!users[to].online) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'User is offline'
    }));
    return;
  }

  if (users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'battle_invite',
      from: username,
      battleId
    }));
  }
}

function handleChatMessage(username, data) {
  const { message, recipient } = data;
  const timestamp = Date.now();

  if (recipient) {
    // Private message
    const chatId = [username, recipient].sort().join('_');
    if (!chatMessages.private[chatId]) {
      chatMessages.private[chatId] = [];
    }

    const msg = {
      type: 'private',
      sender: username,
      recipient,
      message,
      timestamp
    };

    chatMessages.private[chatId].push(msg);

    // Send to recipient if online
    if (users[recipient] && users[recipient].chatWs) {
      users[recipient].chatWs.send(JSON.stringify({
        type: 'chat_message',
        sender: username,
        message,
        timestamp,
        isOwn: false
      }));
    }

    // Send back to sender
    if (users[username] && users[username].chatWs) {
      users[username].chatWs.send(JSON.stringify({
        type: 'chat_message',
        sender: username,
        message,
        timestamp,
        isOwn: true
      }));
    }
  } else {
    // Global message
    const msg = {
      type: 'global',
      sender: username,
      message,
      timestamp
    };

    chatMessages.global.push(msg);
    broadcastChatMessage(username, message, timestamp);
  }
}

function handleGetChatHistory(ws, username, data) {
  const { recipient, limit = 50 } = data;

  if (recipient) {
    // Private chat history
    const chatId = [username, recipient].sort().join('_');
    if (!chatMessages.private[chatId]) {
      chatMessages.private[chatId] = [];
    }

    ws.send(JSON.stringify({
      type: 'chat_history',
      messages: chatMessages.private[chatId].slice(-limit),
      recipient
    }));
  } else {
    // Global chat history
    ws.send(JSON.stringify({
      type: 'chat_history',
      messages: chatMessages.global.slice(-limit)
    }));
  }
}

function broadcastChatMessage(sender, message, timestamp) {
  Object.keys(users).forEach(username => {
    if (users[username].chatWs) {
      users[username].chatWs.send(JSON.stringify({
        type: 'chat_message',
        sender,
        message,
        timestamp,
        isOwn: username === sender
      }));
    }
  });
}

function broadcastSystemMessage(message) {
  Object.keys(users).forEach(username => {
    if (users[username].chatWs) {
      users[username].chatWs.send(JSON.stringify({
        type: 'system_message',
        message
      }));
    }
  });
}


// Battle state management
const battles = {};

// Battle WebSocket - Enhanced
battleServer.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const battleId = urlParams.get('battleId');
  const username = urlParams.get('username');

  if (!battleId || !username) {
    ws.close();
    return;
  }

  // Register player in battle
  if (!battles[battleId]) {
    battles[battleId] = {
      players: {},
      startTime: null,
      duration: 30000, // 30 seconds
      state: 'waiting'
    };
  }

  const battle = battles[battleId];
  battle.players[username] = {
    ws,
    score: 0,
    cps: 0,
    lastClickTime: 0,
    clickCount: 0
  };

  // Send initial battle state
  ws.send(JSON.stringify({
    type: 'battle_joined',
    battleId,
    opponent: Object.keys(battle.players).find(u => u !== username),
    state: battle.state
  }));

  // If both players connected, start battle
  if (Object.keys(battle.players).length === 2 && battle.state === 'waiting') {
    battle.state = 'active';
    battle.startTime = Date.now();

    // Notify both players
    Object.entries(battle.players).forEach(([user, data]) => {
      data.ws.send(JSON.stringify({
        type: 'battle_start',
        battleId,
        opponent: Object.keys(battle.players).find(u => u !== user),
        opponentLevel: users[Object.keys(battle.players).find(u => u !== user)]?.level || 1
      }));
    });

    // Start battle timer
    const battleTimer = setInterval(() => {
      const timeLeft = Math.max(0, battle.duration - (Date.now() - battle.startTime));

      // Update CPS for both players
      Object.values(battle.players).forEach(player => {
        const now = Date.now();
        if (now - player.lastClickTime > 1000) {
          player.cps = 0;
        } else {
          player.cps = player.clickCount / ((now - player.lastClickTime) / 1000);
        }
      });

      // Send updates to both players
      Object.entries(battle.players).forEach(([user, data]) => {
        const opponent = Object.keys(battle.players).find(u => u !== user);
        data.ws.send(JSON.stringify({
          type: 'battle_update',
          timeLeft: Math.ceil(timeLeft / 1000),
          yourScore: data.score,
          opponentScore: battle.players[opponent].score,
          yourCps: data.cps,
          opponentCps: battle.players[opponent].cps
        }));
      });

      // End battle when time's up
      if (timeLeft <= 0) {
        clearInterval(battleTimer);
        endBattle(battleId);
      }
    }, 1000);
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'battle_click' && battle.state === 'active') {
        const player = battle.players[username];
        const now = Date.now();

        // Calculate CPS
        if (now - player.lastClickTime > 1000) {
          player.lastClickTime = now;
          player.clickCount = 0;
        }
        player.clickCount++;
        player.cps = player.clickCount / ((now - player.lastClickTime) / 1000);

        // Increase score (use player's perclick value from users if available)
        const perClick = users[username]?.perclick || 1;
        player.score += perClick;

        // Notify opponent
        const opponent = Object.keys(battle.players).find(u => u !== username);
        if (opponent && battle.players[opponent].ws) {
          battle.players[opponent].ws.send(JSON.stringify({
            type: 'battle_click_update',
            opponentScore: player.score,
            opponentCps: player.cps
          }));
        }
      }
    } catch (e) {
      console.error('Error processing battle message:', e);
    }
  });

  ws.on('close', () => {
    // Remove player from battle
    if (battles[battleId] && battles[battleId].players[username]) {
      delete battles[battleId].players[username];

      // Notify opponent if still connected
      const opponent = Object.keys(battles[battleId].players).find(u => u !== username);
      if (opponent && battles[battleId].players[opponent].ws) {
        battles[battleId].players[opponent].ws.send(JSON.stringify({
          type: 'opponent_disconnected'
        }));
      }

      // Clean up if battle is empty
      if (Object.keys(battles[battleId].players).length === 0) {
        delete battles[battleId];
      }
    }
  });
});

function endBattle(battleId) {
  const battle = battles[battleId];
  if (!battle) return;

  const players = Object.keys(battle.players);
  if (players.length !== 2) return;

  const player1 = battle.players[players[0]];
  const player2 = battle.players[players[1]];

  let winner, reward;
  if (player1.score > player2.score) {
    winner = players[0];
    reward = calculateReward(player1.score, player2.score);
  } else if (player2.score > player1.score) {
    winner = players[1];
    reward = calculateReward(player2.score, player1.score);
  } else {
    winner = 'draw';
    reward = Math.floor(calculateReward(player1.score, player2.score) / 2);
  }

  // Notify both players
  player1.ws.send(JSON.stringify({
    type: 'battle_end',
    winner: winner === players[0] ? 'you' : winner === 'draw' ? 'draw' : 'opponent',
    yourScore: player1.score,
    opponentScore: player2.score,
    reward: winner === players[0] ? reward : winner === 'draw' ? Math.floor(reward / 2) : 0
  }));

  player2.ws.send(JSON.stringify({
    type: 'battle_end',
    winner: winner === players[1] ? 'you' : winner === 'draw' ? 'draw' : 'opponent',
    yourScore: player2.score,
    opponentScore: player1.score,
    reward: winner === players[1] ? reward : winner === 'draw' ? Math.floor(reward / 2) : 0
  }));

  // Clean up
  delete battles[battleId];
}

function calculateReward(winnerScore, loserScore) {
  const baseReward = 50;
  const scoreDifference = winnerScore - loserScore;
  const multiplier = 1 + (scoreDifference / (winnerScore + 1));
  return Math.floor(baseReward * multiplier);
}

server.listen(10000, () => {
  console.log('Server started on port 10000');
});