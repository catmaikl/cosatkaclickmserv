// server.js
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');
const cors = require('cors'); // Добавляем модуль CORS

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const battleServer = new WebSocket.Server({ port: 8081 });

// Настройки CORS
const corsOptions = {
  origin: 'https://cosatka-clickgame-277.netlify.app', // Разрешаем запросы с любого источника (в продакшене укажите конкретные домены)
  methods: ['GET', 'POST', 'OPTIONS'], // Разрешенные HTTP методы
  allowedHeaders: ['Content-Type', 'Authorization'] // Разрешенные заголовки
};

// Применяем CORS middleware
app.use(cors(corsOptions));

// Для предварительных OPTIONS запросов
app.options('*', cors(corsOptions));

// In-memory database (в реальном приложении используйте MongoDB/PostgreSQL)
const users = {};
const friendships = {
  requests: [],
  friends: {}
};

// Middleware
app.use(express.json());

// HTTP API endpoints
app.post('/api/friends/request', cors(corsOptions), (req, res) => {
  const { from, to } = req.body;
  
  if (!users[from] || !users[to]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (friendships.requests.some(r => r.from === from && r.to === to)) {
    return res.status(400).json({ error: 'Request already sent' });
  }
  
  friendships.requests.push({ from, to, id: uuid.v4() });
  
  // Notify recipient if online
  if (users[to] && users[to].ws) {
    users[to].ws.send(JSON.stringify({
      type: 'friend_request',
      from,
      requestId: friendships.requests[friendships.requests.length - 1].id
    }));
  }
  
  res.json({ success: true });
});

app.post('/api/friends/accept', cors(corsOptions), (req, res) => {
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

app.get('/api/friends/:username', cors(corsOptions), (req, res) => {
  const { username } = req.params;
  res.json({
    friends: friendships.friends[username] || [],
    incomingRequests: friendships.requests.filter(r => r.to === username),
    outgoingRequests: friendships.requests.filter(r => r.from === username)
  });
});

// WebSocket connection
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
    const data = JSON.parse(message);
    
    if (data.type === 'battle_invite') {
      const { to } = data;
      if (users[to] && users[to].ws) {
        users[to].ws.send(JSON.stringify({
          type: 'battle_invite',
          from: username,
          battleId: uuid.v4()
        }));
      }
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

const activeBattles = {};

battleServer.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const battleId = urlParams.get('battleId');
    const username = urlParams.get('username');
    
    if (!battleId || !username) {
        ws.close();
        return;
    }
    
    // Регистрируем игрока в баттле
    if (!activeBattles[battleId]) {
        activeBattles[battleId] = {
            players: {},
            startTime: null,
            timer: null,
            duration: 30000 // 30 секунд
        };
    }
    
    activeBattles[battleId].players[username] = {
        ws,
        score: 0,
        cps: 0,
        perClick: 1
    };
    
    // Когда оба игрока подключились
    if (Object.keys(activeBattles[battleId].players).length === 2) {
        startBattle(battleId);
    }
    
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        if (data.type === 'player_info') {
            activeBattles[battleId].players[username].perClick = data.perClick;
        }
        else if (data.type === 'battle_click') {
            const battle = activeBattles[battleId];
            if (battle && battle.players[username]) {
                battle.players[username].score += data.value;
                battle.players[username].cps = data.cps;
                
                // Отправляем обновление второму игроку
                const opponent = Object.keys(battle.players).find(u => u !== username);
                if (opponent && battle.players[opponent].ws) {
                    battle.players[opponent].ws.send(JSON.stringify({
                        type: 'battle_update',
                        timeLeft: Math.ceil((battle.duration - (Date.now() - battle.startTime)) / 1000),
                        opponentScore: battle.players[username].score,
                        opponentCps: battle.players[username].cps
                    }));
                }
            }
        }
    });
    
    ws.on('close', () => {
        const battle = activeBattles[battleId];
        if (battle) {
            // Уведомляем второго игрока об отключении
            const opponent = Object.keys(battle.players).find(u => u !== username);
            if (opponent && battle.players[opponent].ws) {
                battle.players[opponent].ws.send(JSON.stringify({
                    type: 'opponent_disconnected'
                }));
            }
            
            // Очищаем баттл
            if (battle.timer) clearTimeout(battle.timer);
            delete activeBattles[battleId];
        }
    });
});

function startBattle(battleId) {
    const battle = activeBattles[battleId];
    battle.startTime = Date.now();
    
    // Отправляем сообщение о начале всем игрокам
    Object.values(battle.players).forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'battle_start',
            timeLeft: battle.duration / 1000
        }));
    });
    
    // Таймер баттла
    battle.timer = setTimeout(() => {
        endBattle(battleId);
    }, battle.duration);
    
    // Интервал для обновления времени
    const interval = setInterval(() => {
        const timeLeft = Math.ceil((battle.duration - (Date.now() - battle.startTime)) / 1000);
        
        Object.values(battle.players).forEach(player => {
            player.ws.send(JSON.stringify({
                type: 'battle_update',
                timeLeft: timeLeft,
                opponentScore: 0, // Будет обновлено при кликах
                opponentCps: 0
            }));
        });
        
        if (timeLeft <= 0) {
            clearInterval(interval);
        }
    }, 1000);
}

function endBattle(battleId) {
    const battle = activeBattles[battleId];
    if (!battle) return;
    
    const players = Object.entries(battle.players);
    const [player1, player2] = players;
    
    // Определяем победителя
    let winner = null;
    if (player1[1].score > player2[1].score) winner = player1[0];
    else if (player2[1].score > player1[1].score) winner = player2[0];
    
    // Награда (базовая + бонус за победу)
    const baseReward = 100;
    const winnerReward = baseReward * 2;
    const loserReward = baseReward;
    
    // Отправляем результаты
    players.forEach(([username, player]) => {
        const isWinner = winner === username;
        const isDraw = winner === null;
        
        player.ws.send(JSON.stringify({
            type: 'battle_end',
            winner: winner,
            yourScore: player.score,
            opponentScore: players.find(p => p[0] !== username)[1].score,
            reward: isDraw ? baseReward : (isWinner ? winnerReward : loserReward)
        }));
    });
    
    // Очищаем баттл
    delete activeBattles[battleId];
}

server.listen(10000, () => {
  console.log('Server started on port 10000');
});