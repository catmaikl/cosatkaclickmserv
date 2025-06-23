// server.js - полная реализация

const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');

const server = http.createServer((req, res) => {
  // Установите CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Request-Method', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', '*');
  
  // Обработка preflight запросов
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }
  
  // Проверка здоровья сервера
  if (req.url === '/health') {
    res.writeHead(200);
    return res.end('OK');
  }
  
  // Все остальные запросы
  res.writeHead(404);
  res.end('Not Found');
});

server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

// Структуры данных
const players = new Map();       // { playerId -> playerData }
const battles = new Map();       // { battleId -> battleData }
const friendRequests = new Map(); // { toPlayerId -> Set(fromPlayerId) }
const chatRooms = new Map();     // { roomId -> Set(playerId) }

// Основной обработчик соединений
wss.on('connection', (ws) => {
  const playerId = uuid.v4();
  console.log(`New connection: ${playerId}`);

  // Обработчик входящих сообщений
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, playerId, data);
    } catch (e) {
      console.error('Error parsing message:', e);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  // Обработчик закрытия соединения
  ws.on('close', () => {
    const player = players.get(playerId);
    if (player) {
      console.log(`Player disconnected: ${player.username} (${playerId})`);
      
      // Уведомляем друзей о выходе
      notifyFriends(playerId, { 
        type: 'friend_status', 
        playerId, 
        status: 'offline' 
      });
      
      // Выходим из всех чатов
      leaveAllChats(playerId);
      
      // Удаляем из ожидающих баттла
      if (player.searchingBattle) {
        battleQueue = battleQueue.filter(id => id !== playerId);
      }
      
      players.delete(playerId);
    }
  });
});

// Обработка входящих сообщений
function handleMessage(ws, playerId, data) {
  const player = players.get(playerId) || {};
  
  switch (data.type) {
    // Регистрация игрока
    case 'register':
      registerPlayer(ws, playerId, data);
      break;
      
    // Система друзей
    case 'friend_request':
      sendFriendRequest(playerId, data.username);
      break;
    case 'friend_response':
      handleFriendResponse(playerId, data.requestId, data.accept);
      break;
    case 'friend_remove':
      removeFriend(playerId, data.friendId);
      break;
      
    // Чат
    case 'chat_join':
      joinChat(playerId, data.roomId);
      break;
    case 'chat_leave':
      leaveChat(playerId, data.roomId);
      break;
    case 'chat_message':
      sendChatMessage(playerId, data.roomId, data.message);
      break;
      
    // Баттлы
    case 'find_battle':
      addToBattleQueue(playerId);
      break;
    case 'battle_invite':
      sendBattleInvite(playerId, data.friendId);
      break;
    case 'battle_invite_response':
      handleBattleInviteResponse(playerId, data.inviteId, data.accept);
      break;
    case 'battle_click':
      handleBattleClick(playerId, data.battleId, data.value);
      break;
    case 'battle_surrender':
      handleBattleSurrender(playerId, data.battleId);
      break;
      
    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

// ========== СИСТЕМА ДРУЗЕЙ ==========

function registerPlayer(ws, playerId, data) {
  const player = {
    ws,
    id: playerId,
    username: data.username,
    level: data.level || 1,
    friends: new Set(),
    status: 'online',
    searchingBattle: false,
    currentBattle: null
  };
  
  players.set(playerId, player);
  
  // Загружаем друзей из БД (заглушка)
  // В реальном приложении здесь будет загрузка из базы данных
  loadFriendsFromDB(playerId).then(friends => {
    friends.forEach(friend => player.friends.add(friend));
  });
  
  ws.send(JSON.stringify({ 
    type: 'registered', 
    playerId,
    friends: Array.from(player.friends).map(id => getPlayerInfo(id))
  }));
}

async function loadFriendsFromDB(playerId) {
  // Заглушка - в реальном приложении здесь будет запрос к БД
  return [];
}

function sendFriendRequest(fromPlayerId, toUsername) {
  const fromPlayer = players.get(fromPlayerId);
  if (!fromPlayer) return;

  // Ищем игрока по имени
  let toPlayer = null;
  for (const [id, player] of players) {
    if (player.username === toUsername) {
      toPlayer = player;
      break;
    }
  }

  if (!toPlayer) {
    return sendError(fromPlayer.ws, 'Игрок не найден');
  }

  if (fromPlayer.friends.has(toPlayer.id)) {
    return sendError(fromPlayer.ws, 'Этот игрок уже у вас в друзьях');
  }

  // Сохраняем запрос
  if (!friendRequests.has(toPlayer.id)) {
    friendRequests.set(toPlayer.id, new Set());
  }
  friendRequests.get(toPlayer.id).add(fromPlayerId);

  // Уведомляем получателя
  toPlayer.ws.send(JSON.stringify({
    type: 'friend_request',
    requestId: uuid.v4(),
    from: getPlayerInfo(fromPlayerId),
    timestamp: Date.now()
  }));
}

function handleFriendResponse(playerId, requestId, accept) {
  const player = players.get(playerId);
  if (!player) return;

  // Находим запрос (упрощенная логика)
  // В реальном приложении нужно хранить запросы с ID
  const requestFound = friendRequests.get(playerId)?.size > 0;
  
  if (!requestFound) {
    return sendError(player.ws, 'Запрос не найден');
  }

  // Получаем ID отправителя (упрощенно берем первый)
  const fromPlayerId = Array.from(friendRequests.get(playerId))[0];
  const fromPlayer = players.get(fromPlayerId);
  
  if (!fromPlayer) {
    friendRequests.get(playerId).delete(fromPlayerId);
    return sendError(player.ws, 'Игрок больше не в сети');
  }

  if (accept) {
    // Добавляем в друзья
    player.friends.add(fromPlayerId);
    fromPlayer.friends.add(playerId);
    
    // Уведомляем обоих игроков
    player.ws.send(JSON.stringify({
      type: 'friend_added',
      friend: getPlayerInfo(fromPlayerId)
    }));
    
    fromPlayer.ws.send(JSON.stringify({
      type: 'friend_added',
      friend: getPlayerInfo(playerId)
    }));
    
    // Сохраняем в БД (заглушка)
    saveFriendship(playerId, fromPlayerId);
  } else {
    // Отклонение запроса
    fromPlayer.ws.send(JSON.stringify({
      type: 'friend_rejected',
      by: player.username
    }));
  }

  // Удаляем запрос
  friendRequests.get(playerId).delete(fromPlayerId);
}

function removeFriend(playerId, friendId) {
  const player = players.get(playerId);
  const friend = players.get(friendId);
  
  if (!player || !friend) return;

  player.friends.delete(friendId);
  friend.friends.delete(playerId);
  
  // Уведомляем
  player.ws.send(JSON.stringify({
    type: 'friend_removed',
    friendId
  }));
  
  if (friend.ws) {
    friend.ws.send(JSON.stringify({
      type: 'friend_removed',
      friendId: playerId
    }));
  }
  
  // Удаляем из БД (заглушка)
  removeFriendship(playerId, friendId);
}

// ========== ЧАТ ==========

function joinChat(playerId, roomId) {
  const player = players.get(playerId);
  if (!player) return;

  if (!chatRooms.has(roomId)) {
    chatRooms.set(roomId, new Set());
  }
  
  chatRooms.get(roomId).add(playerId);
  
  player.ws.send(JSON.stringify({
    type: 'chat_joined',
    roomId,
    members: Array.from(chatRooms.get(roomId)).map(id => getPlayerInfo(id))
  }));
  
  // Уведомляем других участников
  broadcastToRoom(roomId, playerId, {
    type: 'chat_member_joined',
    roomId,
    player: getPlayerInfo(playerId)
  });
}

function leaveChat(playerId, roomId) {
  if (!chatRooms.has(roomId)) return;
  
  chatRooms.get(roomId).delete(playerId);
  
  const player = players.get(playerId);
  if (player) {
    player.ws.send(JSON.stringify({
      type: 'chat_left',
      roomId
    }));
  }
  
  // Уведомляем других участников
  broadcastToRoom(roomId, playerId, {
    type: 'chat_member_left',
    roomId,
    playerId
  });
  
  // Удаляем комнату если пустая
  if (chatRooms.get(roomId).size === 0) {
    chatRooms.delete(roomId);
  }
}

function leaveAllChats(playerId) {
  chatRooms.forEach((members, roomId) => {
    if (members.has(playerId)) {
      leaveChat(playerId, roomId);
    }
  });
}

function sendChatMessage(playerId, roomId, message) {
  if (!chatRooms.has(roomId)) return;
  
  const player = players.get(playerId);
  if (!player || !chatRooms.get(roomId).has(playerId)) return;
  
  // Проверка на спам и плохие слова (упрощенно)
  if (message.length > 200) {
    return sendError(player.ws, 'Сообщение слишком длинное');
  }
  
  const chatMessage = {
    type: 'chat_message',
    roomId,
    from: getPlayerInfo(playerId),
    message,
    timestamp: Date.now()
  };
  
  broadcastToRoom(roomId, playerId, chatMessage);
  
  // Сохраняем в историю (заглушка)
  saveChatMessage(roomId, playerId, message);
}

// ========== БАТТЛЫ ==========

let battleQueue = [];

function addToBattleQueue(playerId) {
  const player = players.get(playerId);
  if (!player || player.searchingBattle || player.currentBattle) return;
  
  player.searchingBattle = true;
  
  // Ищем соперника
  if (battleQueue.length > 0) {
    const opponentId = battleQueue.pop();
    const opponent = players.get(opponentId);
    
    if (opponent && opponent.searchingBattle) {
      return startBattle(playerId, opponentId);
    }
  }
  
  // Добавляем в очередь
  battleQueue.push(playerId);
  player.ws.send(JSON.stringify({
    type: 'battle_searching'
  }));
}

function startBattle(player1Id, player2Id) {
  const player1 = players.get(player1Id);
  const player2 = players.get(player2Id);
  
  if (!player1 || !player2) return;
  
  const battleId = uuid.v4();
  const battle = {
    id: battleId,
    players: [player1Id, player2Id],
    scores: [0, 0],
    cps: [0, 0], // Clicks per second
    startTime: Date.now(),
    duration: 30000 // 30 секунд
  };
  
  battles.set(battleId, battle);
  
  player1.searchingBattle = false;
  player1.currentBattle = battleId;
  player2.searchingBattle = false;
  player2.currentBattle = battleId;
  
  // Уведомляем игроков
  const battleStartMessage = {
    type: 'battle_start',
    battleId,
    opponent: getPlayerInfo(player1Id === player1Id ? player2Id : player1Id),
    startTime: battle.startTime,
    duration: battle.duration
  };
  
  player1.ws.send(JSON.stringify(battleStartMessage));
  player2.ws.send(JSON.stringify(battleStartMessage));
  
  // Запускаем таймер баттла
  const battleTimer = setInterval(() => {
    const remaining = battle.startTime + battle.duration - Date.now();
    
    if (remaining <= 0) {
      clearInterval(battleTimer);
      endBattle(battleId);
      return;
    }
    
    // Обновляем CPS (клики в секунду)
    battle.cps = battle.cps.map(c => c * 0.9); // Плавное уменьшение
    
    // Рассылаем обновление
    broadcastBattleUpdate(battleId, {
      timeLeft: Math.ceil(remaining / 1000),
      scores: battle.scores,
      cps: battle.cps
    });
  }, 1000);
}

function handleBattleClick(playerId, battleId, value) {
  const battle = battles.get(battleId);
  if (!battle) return;
  
  const playerIndex = battle.players.indexOf(playerId);
  if (playerIndex === -1) return;
  
  // Обновляем счет
  battle.scores[playerIndex] += value;
  
  // Обновляем CPS
  const now = Date.now();
  if (!battle.lastClickTimes) {
    battle.lastClickTimes = [0, 0];
    battle.clickCounts = [0, 0];
  }
  
  if (now - battle.lastClickTimes[playerIndex] > 1000) {
    battle.lastClickTimes[playerIndex] = now;
    battle.clickCounts[playerIndex] = 0;
  }
  
  battle.clickCounts[playerIndex]++;
  battle.cps[playerIndex] = battle.clickCounts[playerIndex] / 
    ((now - battle.lastClickTimes[playerIndex] + 1) / 1000);
}

function endBattle(battleId) {
  const battle = battles.get(battleId);
  if (!battle) return;
  
  const [player1Id, player2Id] = battle.players;
  const [score1, score2] = battle.scores;
  
  // Определяем победителя
  let winnerId = null;
  if (score1 > score2) winnerId = player1Id;
  else if (score2 > score1) winnerId = player2Id;
  
  // Награда
  const reward = calculateBattleReward(score1 + score2);
  
  // Уведомляем игроков
  const player1 = players.get(player1Id);
  const player2 = players.get(player2Id);
  
  if (player1) {
    player1.currentBattle = null;
    player1.ws.send(JSON.stringify({
      type: 'battle_end',
      battleId,
      yourScore: score1,
      opponentScore: score2,
      winner: winnerId === player1Id ? 'you' : 
              winnerId === player2Id ? 'opponent' : 'draw',
      reward
    }));
  }
  
  if (player2) {
    player2.currentBattle = null;
    player2.ws.send(JSON.stringify({
      type: 'battle_end',
      battleId,
      yourScore: score2,
      opponentScore: score1,
      winner: winnerId === player2Id ? 'you' : 
              winnerId === player1Id ? 'opponent' : 'draw',
      reward
    }));
  }
  
  battles.delete(battleId);
}

function sendBattleInvite(fromPlayerId, friendId) {
  const fromPlayer = players.get(fromPlayerId);
  const friend = players.get(friendId);
  
  if (!fromPlayer || !friend) {
    return sendError(fromPlayer?.ws, 'Друг не в сети');
  }
  
  if (!fromPlayer.friends.has(friendId)) {
    return sendError(fromPlayer.ws, 'Этот игрок не ваш друг');
  }
  
  if (friend.currentBattle) {
    return sendError(fromPlayer.ws, 'Друг уже в баттле');
  }
  
  const inviteId = uuid.v4();
  
  friend.ws.send(JSON.stringify({
    type: 'battle_invite',
    inviteId,
    from: getPlayerInfo(fromPlayerId),
    timestamp: Date.now()
  }));
}

function handleBattleInviteResponse(playerId, inviteId, accept) {
  const player = players.get(playerId);
  if (!player) return;
  
  // В реальном приложении нужно проверять inviteId
  // Здесь упрощенная логика
  
  if (accept) {
    // Находим отправителя приглашения (упрощенно)
    let inviter = null;
    for (const [id, p] of players) {
      if (p.friends.has(playerId)) {
        inviter = p;
        break;
      }
    }
    
    if (inviter && !inviter.currentBattle) {
      startBattle(inviter.id, playerId);
    }
  }
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function getPlayerInfo(playerId) {
  const player = players.get(playerId);
  if (!player) return null;
  
  return {
    id: player.id,
    username: player.username,
    level: player.level,
    online: player.ws && player.ws.readyState === WebSocket.OPEN
  };
}

function notifyFriends(playerId, message) {
  const player = players.get(playerId);
  if (!player) return;
  
  player.friends.forEach(friendId => {
    const friend = players.get(friendId);
    if (friend?.ws) {
      friend.ws.send(JSON.stringify({
        ...message,
        playerId // Добавляем ID игрока, от которого пришло уведомление
      }));
    }
  });
}

function broadcastToRoom(roomId, excludePlayerId, message) {
  if (!chatRooms.has(roomId)) return;
  
  chatRooms.get(roomId).forEach(playerId => {
    if (playerId !== excludePlayerId) {
      const player = players.get(playerId);
      if (player?.ws) {
        player.ws.send(JSON.stringify(message));
      }
    }
  });
}

function broadcastBattleUpdate(battleId, update) {
  const battle = battles.get(battleId);
  if (!battle) return;
  
  const message = {
    type: 'battle_update',
    battleId,
    ...update
  };
  
  battle.players.forEach(playerId => {
    const player = players.get(playerId);
    if (player?.ws) {
      player.ws.send(JSON.stringify(message));
    }
  });
}

function sendError(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}

// Заглушки для работы с БД
async function saveFriendship(player1Id, player2Id) {
  // В реальном приложении здесь будет запрос к БД
}

async function removeFriendship(player1Id, player2Id) {
  // В реальном приложении здесь будет запрос к БД
}

async function saveChatMessage(roomId, playerId, message) {
  // В реальном приложении здесь будет запрос к БД
}

function calculateBattleReward(totalScore) {
  // Базовая награда + бонус за активность
  return Math.floor(50 + totalScore * 0.1);
}

const PORT = process.env.PORT || 10000;
// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server started on port 8080');
  const WebSocket = require('ws');
  const http = require('http');
  const uuid = require('uuid');

  const server = http.createServer();
  const wss = new WebSocket.Server({ server });

  // Улучшенные структуры данных
  const players = new Map();       // { playerId -> playerData }
  const battles = new Map();       // { battleId -> battleData }
  const friendRequests = new Map(); // { requestId -> requestData }
  const chatRooms = new Map();     // { roomId -> Set(playerId) }
  const activeInvites = new Map(); // { inviteId -> inviteData }

  // Таймеры для очистки
  const cleanupIntervals = {
    battles: setInterval(cleanupBattles, 60000),
    friendRequests: setInterval(cleanupFriendRequests, 3600000)
  };

  // Основной обработчик соединений
  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`New connection from ${ip}`);

    const playerId = uuid.v4();
    let heartbeatInterval;

    // Функция для отправки ping
    const sendHeartbeat = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    };

    // Начинаем отправлять ping каждые 30 секунд
    heartbeatInterval = setInterval(sendHeartbeat, 30000);

    ws.on('pong', () => {
      // Клиент ответил на ping, соединение активно
    });

    // Обработчик входящих сообщений с улучшенной валидацией
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        // Базовая валидация
        if (!data.type || typeof data.type !== 'string') {
          return sendError(ws, 'Invalid message format: type is required');
        }
        
        // Проверка размера сообщения
        if (message.length > 1024) {
          return sendError(ws, 'Message too large');
        }
        
        handleMessage(ws, playerId, data);
      } catch (e) {
        console.error('Error parsing message:', e);
        sendError(ws, 'Invalid message format');
      }
    });

    // Улучшенный обработчик закрытия соединения
    ws.on('close', () => {
      clearInterval(heartbeatInterval);
      handleDisconnect(playerId);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for player ${playerId}:`, err);
      handleDisconnect(playerId);
    });
  });

  // Улучшенная функция обработки отключения
  function handleDisconnect(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    console.log(`Player disconnected: ${player.username} (${playerId})`);
    
    // Уведомляем друзей о выходе
    notifyFriends(playerId, { 
      type: 'friend_status', 
      playerId, 
      status: 'offline' 
    });
    
    // Выходим из всех чатов
    leaveAllChats(playerId);
    
    // Удаляем из очереди баттлов
    if (player.searchingBattle) {
      battleQueue = battleQueue.filter(id => id !== playerId);
    }
    
    // Завершаем активные баттлы
    if (player.currentBattle) {
      const battle = battles.get(player.currentBattle);
      if (battle) {
        battle.players.forEach(pId => {
          if (pId !== playerId) {
            const opponent = players.get(pId);
            if (opponent?.ws) {
              opponent.ws.send(JSON.stringify({
                type: 'battle_ended',
                reason: 'opponent_disconnected'
              }));
            }
          }
        });
        battles.delete(player.currentBattle);
      }
    }
    
    players.delete(playerId);
  }

  // Улучшенная функция регистрации игрока
  function registerPlayer(ws, playerId, data) {
    // Валидация данных
    if (!data.username || typeof data.username !== 'string' || 
        data.username.length < 3 || data.username.length > 20) {
      return sendError(ws, 'Invalid username (3-20 characters)');
    }

    // Проверка на уникальность имени
    for (const [id, player] of players) {
      if (player.username === data.username) {
        return sendError(ws, 'Username already taken');
      }
    }

    const player = {
      ws,
      id: playerId,
      username: data.username,
      level: Math.max(1, Math.min(100, parseInt(data.level) || 1)),
      friends: new Set(),
      status: 'online',
      searchingBattle: false,
      currentBattle: null,
      lastActivity: Date.now()
    };
    
    players.set(playerId, player);
    
    // Загружаем друзей из БД
    loadFriendsFromDB(playerId).then(friends => {
      friends.forEach(friend => {
        if (players.has(friend.id)) {
          player.friends.add(friend.id);
        }
      });
      
      ws.send(JSON.stringify({ 
        type: 'registered', 
        playerId,
        friends: Array.from(player.friends).map(id => getPlayerInfo(id))
      }));
    }).catch(err => {
      console.error('Error loading friends:', err);
      ws.send(JSON.stringify({ 
        type: 'registered', 
        playerId,
        friends: []
      }));
    });
  }

  // Улучшенная система друзей
  function sendFriendRequest(fromPlayerId, toUsername) {
    const fromPlayer = players.get(fromPlayerId);
    if (!fromPlayer) return;

    // Проверка на самого себя
    if (fromPlayer.username === toUsername) {
      return sendError(fromPlayer.ws, 'You cannot add yourself');
    }

    // Ищем игрока по имени
    let toPlayer = null;
    for (const [id, player] of players) {
      if (player.username === toUsername) {
        toPlayer = player;
        break;
      }
    }

    if (!toPlayer) {
      return sendError(fromPlayer.ws, 'Player not found');
    }

    if (fromPlayer.friends.has(toPlayer.id)) {
      return sendError(fromPlayer.ws, 'Already friends');
    }

    // Проверяем, не отправлен ли уже запрос
    for (const [reqId, req] of friendRequests) {
      if (req.from === fromPlayerId && req.to === toPlayer.id) {
        return sendError(fromPlayer.ws, 'Request already sent');
      }
    }

    // Создаем запрос
    const requestId = uuid.v4();
    const request = {
      id: requestId,
      from: fromPlayerId,
      to: toPlayer.id,
      timestamp: Date.now()
    };
    
    friendRequests.set(requestId, request);

    // Уведомляем получателя
    toPlayer.ws.send(JSON.stringify({
      type: 'friend_request',
      requestId,
      from: getPlayerInfo(fromPlayerId),
      timestamp: request.timestamp
    }));

    // Устанавливаем таймер на автоматическое отклонение (24 часа)
    setTimeout(() => {
      if (friendRequests.has(requestId)) {
        friendRequests.delete(requestId);
        fromPlayer.ws.send(JSON.stringify({
          type: 'friend_request_expired',
          to: toPlayer.username
        }));
      }
    }, 86400000);
  }

  // Улучшенная обработка ответа на запрос друга
  function handleFriendResponse(playerId, requestId, accept) {
    const player = players.get(playerId);
    if (!player) return;

    const request = friendRequests.get(requestId);
    if (!request || request.to !== playerId) {
      return sendError(player.ws, 'Invalid request');
    }

    const fromPlayer = players.get(request.from);
    if (!fromPlayer) {
      friendRequests.delete(requestId);
      return sendError(player.ws, 'Player no longer available');
    }

    friendRequests.delete(requestId);

    if (accept) {
      // Добавляем в друзья
      player.friends.add(fromPlayer.id);
      fromPlayer.friends.add(playerId);
      
      // Уведомляем обоих игроков
      const friendInfo = getPlayerInfo(playerId);
      const fromFriendInfo = getPlayerInfo(fromPlayer.id);
      
      player.ws.send(JSON.stringify({
        type: 'friend_added',
        friend: fromFriendInfo
      }));
      
      fromPlayer.ws.send(JSON.stringify({
        type: 'friend_added',
        friend: friendInfo
      }));
      
      // Сохраняем в БД
      saveFriendship(playerId, fromPlayer.id).catch(err => {
        console.error('Error saving friendship:', err);
      });
    } else {
      // Отклонение запроса
      fromPlayer.ws.send(JSON.stringify({
        type: 'friend_rejected',
        by: player.username,
        requestId
      }));
    }
  }

  // Улучшенная система чатов
  function sendChatMessage(playerId, roomId, message) {
    if (!chatRooms.has(roomId)) {
      return sendError(players.get(playerId)?.ws, 'Room not found');
    }

    const player = players.get(playerId);
    if (!player || !chatRooms.get(roomId).has(playerId)) {
      return sendError(player?.ws, 'Not in this room');
    }
    
    // Улучшенная проверка сообщения
    message = message.toString().trim();
    if (message.length === 0) return;
    if (message.length > 200) {
      return sendError(player.ws, 'Message too long (max 200 chars)');
    }

    // Проверка на спам
    if (Date.now() - player.lastMessageTime < 1000) {
      return sendError(player.ws, 'Message too fast');
    }
    player.lastMessageTime = Date.now();

    const chatMessage = {
      type: 'chat_message',
      roomId,
      from: getPlayerInfo(playerId),
      message,
      timestamp: Date.now()
    };
    
    broadcastToRoom(roomId, playerId, chatMessage);
    
    // Сохраняем в историю
    saveChatMessage(roomId, playerId, message).catch(err => {
      console.error('Error saving chat message:', err);
    });
  }

  // Улучшенная система баттлов
  function startBattle(player1Id, player2Id) {
    const player1 = players.get(player1Id);
    const player2 = players.get(player2Id);
    
    if (!player1 || !player2) return;

    // Проверяем, не участвуют ли уже в другом баттле
    if (player1.currentBattle || player2.currentBattle) {
      return;
    }

    const battleId = uuid.v4();
    const battle = {
      id: battleId,
      players: [player1Id, player2Id],
      scores: [0, 0],
      cps: [0, 0],
      startTime: Date.now(),
      duration: 30000,
      lastUpdate: Date.now()
    };
    
    battles.set(battleId, battle);
    
    player1.searchingBattle = false;
    player1.currentBattle = battleId;
    player2.searchingBattle = false;
    player2.currentBattle = battleId;
    
    // Уведомляем игроков
    const battleStartMessage = {
      type: 'battle_start',
      battleId,
      opponent: getPlayerInfo(player1Id === player1.id ? player2Id : player1Id),
      startTime: battle.startTime,
      duration: battle.duration
    };
    
    safeSend(player1.ws, battleStartMessage);
    safeSend(player2.ws, battleStartMessage);
    
    // Запускаем таймер баттла
    const battleTimer = setInterval(() => {
      const battle = battles.get(battleId);
      if (!battle) {
        clearInterval(battleTimer);
        return;
      }
      
      const remaining = battle.startTime + battle.duration - Date.now();
      
      if (remaining <= 0) {
        clearInterval(battleTimer);
        endBattle(battleId);
        return;
      }
      
      // Обновляем CPS (клики в секунду)
      const timeDiff = (Date.now() - battle.lastUpdate) / 1000;
      battle.cps = battle.cps.map(c => Math.max(0, c - c * 0.1 * timeDiff));
      battle.lastUpdate = Date.now();
      
      // Рассылаем обновление
      broadcastBattleUpdate(battleId, {
        timeLeft: Math.ceil(remaining / 1000),
        scores: battle.scores,
        cps: battle.cps.map(c => Math.round(c * 10) / 10) // Округляем до 1 знака
      });
    }, 1000);
  }

  // Улучшенная обработка кликов в баттле
  function handleBattleClick(playerId, battleId, value) {
    const battle = battles.get(battleId);
    if (!battle) return;
    
    const playerIndex = battle.players.indexOf(playerId);
    if (playerIndex === -1) return;
    
    // Проверяем значение
    value = Math.max(1, Math.min(100, parseInt(value) || 1));
    
    // Обновляем счет
    battle.scores[playerIndex] += value;
    
    // Обновляем CPS
    const now = Date.now();
    if (!battle.lastClickTimes) {
      battle.lastClickTimes = [now, now];
      battle.clickCounts = [0, 0];
    }
    
    if (now - battle.lastClickTimes[playerIndex] > 1000) {
      battle.lastClickTimes[playerIndex] = now;
      battle.clickCounts[playerIndex] = 0;
    }
    
    battle.clickCounts[playerIndex]++;
    battle.cps[playerIndex] = battle.clickCounts[playerIndex] / 
      ((now - battle.lastClickTimes[playerIndex] + 1) / 1000);
  }

  // Улучшенная функция завершения баттла
  function endBattle(battleId) {
    const battle = battles.get(battleId);
    if (!battle) return;
    
    const [player1Id, player2Id] = battle.players;
    const [score1, score2] = battle.scores;
    
    // Определяем победителя
    let winnerId = null;
    if (score1 > score2) winnerId = player1Id;
    else if (score2 > score1) winnerId = player2Id;
    
    // Награда (с учетом уровня игроков)
    const player1 = players.get(player1Id);
    const player2 = players.get(player2Id);
    const reward = calculateBattleReward(score1 + score2, 
      player1?.level || 1, 
      player2?.level || 1);
    
    // Уведомляем игроков
    if (player1) {
      player1.currentBattle = null;
      safeSend(player1.ws, {
        type: 'battle_end',
        battleId,
        yourScore: score1,
        opponentScore: score2,
        winner: winnerId === player1Id ? 'you' : 
                winnerId === player2Id ? 'opponent' : 'draw',
        reward
      });
      
      if (winnerId === player1Id) {
        // Обновляем статистику побед
        player1.wins = (player1.wins || 0) + 1;
      }
    }
    
    if (player2) {
      player2.currentBattle = null;
      safeSend(player2.ws, {
        type: 'battle_end',
        battleId,
        yourScore: score2,
        opponentScore: score1,
        winner: winnerId === player2Id ? 'you' : 
                winnerId === player1Id ? 'opponent' : 'draw',
        reward
      });
      
      if (winnerId === player2Id) {
        // Обновляем статистику побед
        player2.wins = (player2.wins || 0) + 1;
      }
    }
    
    battles.delete(battleId);
  }

  // Улучшенная функция приглашения на баттл
  function sendBattleInvite(fromPlayerId, friendId) {
    const fromPlayer = players.get(fromPlayerId);
    const friend = players.get(friendId);
    
    if (!fromPlayer || !friend) {
      return sendError(fromPlayer?.ws, 'Friend not online');
    }
    
    if (!fromPlayer.friends.has(friendId)) {
      return sendError(fromPlayer.ws, 'Not your friend');
    }
    
    if (friend.currentBattle) {
      return sendError(fromPlayer.ws, 'Friend is in battle');
    }
    
    if (fromPlayer.currentBattle) {
      return sendError(fromPlayer.ws, 'You are already in battle');
    }
    
    // Проверяем, не отправлено ли уже приглашение
    for (const [inviteId, invite] of activeInvites) {
      if (invite.from === fromPlayerId && invite.to === friendId && 
          Date.now() - invite.timestamp < 30000) {
        return sendError(fromPlayer.ws, 'Invite already sent');
      }
    }

    const inviteId = uuid.v4();
    const invite = {
      id: inviteId,
      from: fromPlayerId,
      to: friendId,
      timestamp: Date.now()
    };
    
    activeInvites.set(inviteId, invite);
    
    // Устанавливаем таймер на автоматическое отклонение (30 секунд)
    setTimeout(() => {
      if (activeInvites.has(inviteId)) {
        activeInvites.delete(inviteId);
        fromPlayer.ws.send(JSON.stringify({
          type: 'battle_invite_expired',
          to: friend.username
        }));
      }
    }, 30000);

    safeSend(friend.ws, {
      type: 'battle_invite',
      inviteId,
      from: getPlayerInfo(fromPlayerId),
      timestamp: invite.timestamp
    });
  }

  // Улучшенная функция ответа на приглашение
  function handleBattleInviteResponse(playerId, inviteId, accept) {
    const player = players.get(playerId);
    if (!player) return;

    const invite = activeInvites.get(inviteId);
    if (!invite || invite.to !== playerId) {
      return sendError(player.ws, 'Invalid invite');
    }

    activeInvites.delete(inviteId);

    const fromPlayer = players.get(invite.from);
    if (!fromPlayer) {
      return sendError(player.ws, 'Player no longer available');
    }

    if (accept) {
      if (player.currentBattle || fromPlayer.currentBattle) {
        return sendError(player.ws, 'Cannot start battle now');
      }
      
      startBattle(fromPlayer.id, playerId);
    } else {
      safeSend(fromPlayer.ws, {
        type: 'battle_invite_rejected',
        by: player.username,
        inviteId
      });
    }
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

  function safeSend(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        console.error('Error sending message:', err);
      }
    }
  }

  function getPlayerInfo(playerId) {
    const player = players.get(playerId);
    if (!player) return null;
    
    return {
      id: player.id,
      username: player.username,
      level: player.level,
      online: player.ws && player.ws.readyState === WebSocket.OPEN,
      wins: player.wins || 0
    };
  }

  function notifyFriends(playerId, message) {
    const player = players.get(playerId);
    if (!player) return;
    
    player.friends.forEach(friendId => {
      const friend = players.get(friendId);
      if (friend?.ws) {
        safeSend(friend.ws, {
          ...message,
          playerId
        });
      }
    });
  }

  function broadcastToRoom(roomId, excludePlayerId, message) {
    if (!chatRooms.has(roomId)) return;
    
    chatRooms.get(roomId).forEach(playerId => {
      if (playerId !== excludePlayerId) {
        const player = players.get(playerId);
        safeSend(player?.ws, message);
      }
    });
  }

  function broadcastBattleUpdate(battleId, update) {
    const battle = battles.get(battleId);
    if (!battle) return;
    
    const message = {
      type: 'battle_update',
      battleId,
      ...update
    };
    
    battle.players.forEach(playerId => {
      const player = players.get(playerId);
      safeSend(player?.ws, message);
    });
  }

  function sendError(ws, message) {
    safeSend(ws, { type: 'error', message });
  }

  // Функции очистки
  function cleanupBattles() {
    const now = Date.now();
    for (const [battleId, battle] of battles) {
      if (now - battle.startTime > battle.duration + 60000) {
        // Баттл должен был закончиться более минуты назад
        battles.delete(battleId);
        
        // Освобождаем игроков
        battle.players.forEach(playerId => {
          const player = players.get(playerId);
          if (player && player.currentBattle === battleId) {
            player.currentBattle = null;
          }
        });
      }
    }
  }

  function cleanupFriendRequests() {
    const now = Date.now();
    for (const [reqId, req] of friendRequests) {
      if (now - req.timestamp > 86400000) { // 24 часа
        friendRequests.delete(reqId);
      }
    }
  }

  // Улучшенная функция расчета награды
  function calculateBattleReward(totalScore, level1, level2) {
    // Базовая награда + бонус за активность + бонус за уровень
    const base = 50;
    const activityBonus = totalScore * 0.1;
    const levelBonus = Math.min(level1, level2) * 2;
    
    return Math.floor(base + activityBonus + levelBonus);
  }

  // Запуск сервера
  server.listen(8080, () => {
    console.log('Server started on port 8080');
  });

  // Обработка завершения работы
  process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    
    // Очищаем таймеры
    clearInterval(cleanupIntervals.battles);
    clearInterval(cleanupIntervals.friendRequests);
    
    // Закрываем соединения
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutdown');
      }
    });
    
    // Закрываем сервер
    server.close(() => {
      console.log('Server stopped');
      process.exit(0);
    });
  })
});