// server.js - полная реализация

const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');

const server = http.createServer();
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

// Запуск сервера
server.listen(8080, () => {
  console.log('Server started on port 8080');
});