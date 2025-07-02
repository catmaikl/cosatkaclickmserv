const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const gameRooms = {};
const playerSessions = {};
const playerBalances = {};

const MAX_PLAYERS_PER_ROOM = 4;
const INITIAL_BALANCE = 1000;
const TIMEOUT_DURATION = 30000; // 30 секунд

// Функции для работы с колодой
function createDeck() {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

wss.on('connection', (ws) => {
  const playerId = generatePlayerId();
  playerSessions[playerId] = { ws, room: null };
  playerBalances[playerId] = INITIAL_BALANCE;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(playerId, data);
    } catch (error) {
      console.error('Error parsing message:', error);
      sendError(playerId, 'Неверный формат сообщения');
    }
  });
  
  ws.on('close', () => {
    handleDisconnect(playerId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    handleDisconnect(playerId);
  });
  
  // Отправляем приветственное сообщение
  sendMessage(playerId, {
    type: 'welcome',
    playerId,
    balance: playerBalances[playerId],
    message: 'Добро пожаловать в покер!'
  });
});

function generatePlayerId() {
  return Math.random().toString(36).substr(2, 9);
}

function generateRoomId() {
  return Math.random().toString(36).substr(2, 9);
}

function sendMessage(playerId, message) {
  const session = playerSessions[playerId];
  if (session && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(message));
  }
}

function sendError(playerId, errorMessage) {
  sendMessage(playerId, {
    type: 'error',
    message: errorMessage
  });
}

function handleMessage(playerId, data) {
  const session = playerSessions[playerId];
  if (!session) {
    sendError(playerId, 'Сессия не найдена');
    return;
  }
  
  try {
    switch (data.action) {
      case 'createRoom':
        createRoom(playerId, data.roomName);
        break;
      case 'joinRoom':
        joinRoom(playerId, data.roomId);
        break;
      case 'leaveRoom':
        leaveRoom(playerId);
        break;
      case 'getRooms':
        sendRoomList(playerId);
        break;
      case 'startGame':
        startGame(session.room);
        break;
      case 'placeBet':
        handleBet(playerId, data.amount);
        break;
      case 'dealCards':
        dealCards(session.room);
        break;
      case 'drawCards':
        handleDraw(playerId, data.cardsToReplace);
        break;
      case 'fold':
        handleFold(playerId);
        break;
      default:
        sendError(playerId, 'Неизвестное действие');
    }
  } catch (error) {
    console.error('Error handling message:', error);
    sendError(playerId, 'Ошибка обработки запроса');
  }
}

function sendRoomList(playerId) {
  const rooms = Object.values(gameRooms).map(room => ({
    id: room.id,
    name: room.name,
    players: room.players,
    gameState: !!room.gameState
  }));
  
  sendMessage(playerId, {
    type: 'roomList',
    rooms
  });
}

function broadcastRoomList() {
  const rooms = Object.values(gameRooms).map(room => ({
    id: room.id,
    name: room.name,
    players: room.players.length,
    gameState: !!room.gameState
  }));

  // Отправляем всем подключенным клиентам
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'roomList',
        rooms: rooms.filter(room => !room.gameState) // Показываем только комнаты, где игра не началась
      }));
    }
  });
}

function handleDisconnect(playerId) {
  const session = playerSessions[playerId];
  if (session && session.room) {
    leaveRoom(playerId);
  }
  delete playerSessions[playerId];
  delete playerBalances[playerId];
}

function createRoom(playerId, roomName) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    name: roomName || `Комната ${Math.floor(Math.random() * 1000)}`,
    players: [playerId],
    gameState: null,
    deck: [],
    currentPlayer: null,
    timer: null
  };
  
  gameRooms[roomId] = room;
  playerSessions[playerId].room = roomId;
  
  broadcastToRoom(roomId, {
    type: 'roomCreated',
    roomId,
    roomName: room.name,
    players: [playerId]
  });

  broadcastRoomList();
}

function joinRoom(playerId, roomId) {
  const room = gameRooms[roomId];
  if (!room) {
    sendError(playerId, 'Комната не найдена');
    return;
  }
  
  if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
    sendError(playerId, 'Комната заполнена');
    return;
  }
  
  if (room.gameState) {
    sendError(playerId, 'Игра уже началась');
    return;
  }
  
  room.players.push(playerId);
  playerSessions[playerId].room = roomId;
  
  broadcastToRoom(roomId, {
    type: 'playerJoined',
    playerId,
    players: room.players,
    balance: playerBalances[playerId]
  });

  broadcastRoomList();
}

function leaveRoom(playerId) {
  const session = playerSessions[playerId];
  if (!session || !session.room) return;
  
  const roomId = session.room;
  const room = gameRooms[roomId];
  if (!room) return;
  
  room.players = room.players.filter(id => id !== playerId);
  session.room = null;
  
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  
  if (room.players.length === 0) {
    delete gameRooms[roomId];
  } else {
    if (room.gameState) {
      // Если игрок вышел во время игры
      const playerInGame = room.gameState.players.find(p => p.id === playerId);
      if (playerInGame) {
        playerInGame.folded = true;
      }
      checkGameEnd(room);
    }
    
    broadcastToRoom(roomId, {
      type: 'playerLeft',
      playerId,
      players: room.players
    });
  }
  
  broadcastRoomList();
}

function startGame(roomId) {
  const room = gameRooms[roomId];
  if (!room || room.players.length < 2) {
    broadcastToRoom(roomId, {
      type: 'error',
      message: 'Недостаточно игроков для начала игры'
    });
    return;
  }
  
  room.deck = createDeck();
  shuffleDeck(room.deck);
  
  room.gameState = {
    phase: 'betting',
    players: room.players.map(playerId => ({
      id: playerId,
      hand: [],
      bet: 0,
      folded: false,
      drewCards: false,
      placedBet: false // Добавляем этот флаг
    })),
    pot: 0,
    currentPlayer: 0
  };
  
  startTurnTimer(room);
  
  broadcastToRoom(roomId, {
    type: 'gameStarted',
    players: room.players,
    currentPlayer: room.players[0],
    phase: 'betting'
  });
}

function startTurnTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }
  
  room.timer = setTimeout(() => {
    const currentPlayerId = room.gameState.players[room.gameState.currentPlayer].id;
    handleFold(currentPlayerId);
  }, TIMEOUT_DURATION);
}

function handleBet(playerId, amount) {
  const session = playerSessions[playerId];
  if (!session || !session.room) {
    sendError(playerId, 'Вы не в комнате');
    return;
  }
  
  const room = gameRooms[session.room];
  if (!room || !room.gameState) {
    sendError(playerId, 'Игра не начата');
    return;
  }
  
  if (room.gameState.phase !== 'betting') {
    sendError(playerId, 'Не время для ставок');
    return;
  }
  
  const player = room.gameState.players.find(p => p.id === playerId);
  if (!player) {
    sendError(playerId, 'Игрок не найден');
    return;
  }
  
  amount = parseInt(amount);
  if (isNaN(amount)) {
    sendError(playerId, 'Неверная сумма ставки');
    return;
  }
  
  if (playerBalances[playerId] < amount) {
    sendError(playerId, 'Недостаточно средств');
    return;
  }
  
  playerBalances[playerId] -= amount;
  player.bet = amount;
  room.gameState.pot += amount;
  
  // Добавляем флаг, что игрок сделал ставку
  player.placedBet = true;
  
  // Проверяем, все ли игроки сделали ставки
  const allPlayersBetted = room.gameState.players.every(p => p.placedBet || p.folded);
  
  if (allPlayersBetted) {
    // Все сделали ставки - переходим к раздаче карт
    dealCards(room.id);
  } else {
    // Передаем ход следующему игроку
    const currentIndex = room.gameState.players.findIndex(p => p.id === playerId);
    let nextIndex = (currentIndex + 1) % room.gameState.players.length;
    
    // Пропускаем игроков, которые уже сделали ставку или сбросили карты
    while (room.gameState.players[nextIndex].placedBet || room.gameState.players[nextIndex].folded) {
      nextIndex = (nextIndex + 1) % room.gameState.players.length;
      
      // Если все игроки либо сделали ставки, либо сбросили карты
      if (nextIndex === currentIndex) {
        dealCards(room.id);
        return;
      }
    }
    
    room.gameState.currentPlayer = nextIndex;
    startTurnTimer(room);
    
    broadcastToRoom(room.id, {
      type: 'betPlaced',
      playerId,
      amount,
      pot: room.gameState.pot,
      currentPlayer: room.gameState.players[nextIndex].id,
      balance: playerBalances[playerId]
    });
  }
}

function dealCards(roomId) {
  const room = gameRooms[roomId];
  if (!room || !room.gameState || room.gameState.phase !== 'betting') {
    return;
  }
  
  // Раздаем по 5 карт каждому игроку
  room.gameState.players.forEach(player => {
    player.hand = room.deck.splice(0, 5);
  });
  
  room.gameState.phase = 'drawing';
  room.gameState.currentPlayer = 0;
  
  startTurnTimer(room);
  
  broadcastToRoom(roomId, {
    type: 'cardsDealt',
    hands: room.gameState.players.map(player => ({
      playerId: player.id,
      cards: player.id === room.gameState.players[0].id ? 
        player.hand : 
        Array(5).fill({ rank: 'back', suit: 'back' })
    })),
    currentPlayer: room.gameState.players[0].id,
    phase: 'drawing'
  });
}

function handleDraw(playerId, cardsToReplace) {
  const session = playerSessions[playerId];
  if (!session || !session.room) {
    sendError(playerId, 'Вы не в комнате');
    return;
  }
  
  const room = gameRooms[session.room];
  if (!room || !room.gameState || room.gameState.phase !== 'drawing') {
    sendError(playerId, 'Не время для замены карт');
    return;
  }
  
  const player = room.gameState.players.find(p => p.id === playerId);
  if (!player) {
    sendError(playerId, 'Игрок не найден');
    return;
  }
  
  if (room.gameState.players[room.gameState.currentPlayer].id !== playerId) {
    sendError(playerId, 'Сейчас не ваш ход');
    return;
  }
  
  // Заменяем выбранные карты
  cardsToReplace.forEach(index => {
    if (room.deck.length > 0 && index >= 0 && index < player.hand.length) {
      player.hand[index] = room.deck.shift();
    }
  });
  
  player.drewCards = true;
  
  // Передаем ход следующему игроку
  const nextIndex = (room.gameState.currentPlayer + 1) % room.gameState.players.length;
  room.gameState.currentPlayer = nextIndex;
  
  // Проверяем, все ли игроки сделали замену
  const allPlayersDrew = room.gameState.players.every(p => 
    p.drewCards || p.folded
  );
  
  if (allPlayersDrew) {
    endGame(room);
  } else {
    startTurnTimer(room);
    broadcastToRoom(room.id, {
      type: 'cardsDrawn',
      playerId,
      currentPlayer: room.gameState.players[nextIndex].id
    });
  }
}

function handleFold(playerId) {
  const session = playerSessions[playerId];
  if (!session || !session.room) return;
  
  const room = gameRooms[session.room];
  if (!room || !room.gameState) return;
  
  const player = room.gameState.players.find(p => p.id === playerId);
  if (!player) return;
  
  player.folded = true;
  
  broadcastToRoom(room.id, {
    type: 'playerFolded',
    playerId
  });
  
  checkGameEnd(room);
}

function checkGameEnd(room) {
  const activePlayers = room.gameState.players.filter(p => !p.folded);
  
  if (activePlayers.length <= 1) {
    endGame(room);
  }
}

function endGame(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  
  // Определяем победителя среди не сбросивших карты
  const activePlayers = room.gameState.players.filter(p => !p.folded);
  
  if (activePlayers.length === 0) {
    // Все сбросили карты - возвращаем ставки
    room.gameState.players.forEach(player => {
      playerBalances[player.id] += player.bet;
    });
    
    broadcastToRoom(room.id, {
      type: 'gameResult',
      winner: null,
      winningCombination: null,
      pot: 0,
      allHands: [],
      balances: room.gameState.players.map(p => ({
        playerId: p.id,
        balance: playerBalances[p.id]
      }))
    });
  } else if (activePlayers.length === 1) {
    // Один победитель - забирает банк
    const winner = activePlayers[0];
    playerBalances[winner.id] += room.gameState.pot;
    
    broadcastToRoom(room.id, {
      type: 'gameResult',
      winner: winner.id,
      winningCombination: 'Победа по фолду',
      pot: room.gameState.pot,
      allHands: [],
      balances: room.gameState.players.map(p => ({
        playerId: p.id,
        balance: playerBalances[p.id]
      }))
    });
  } else {
    // Определяем победителя по комбинациям
    const playersWithCombinations = activePlayers
      .map(player => ({
        ...player,
        combination: determineCombination(player.hand),
        combinationRank: getCombinationRank(determineCombination(player.hand))
      }));
    
    playersWithCombinations.sort((a, b) => b.combinationRank - a.combinationRank);
    const winner = playersWithCombinations[0];
    
    playerBalances[winner.id] += room.gameState.pot;
    
    broadcastToRoom(room.id, {
      type: 'gameResult',
      winner: winner.id,
      winningCombination: winner.combination,
      pot: room.gameState.pot,
      allHands: room.gameState.players.map(player => ({
        playerId: player.id,
        cards: player.folded ? [] : player.hand,
        combination: player.folded ? null : determineCombination(player.hand)
      })),
      balances: room.gameState.players.map(p => ({
        playerId: p.id,
        balance: playerBalances[p.id]
      }))
    });
  }
  
  // Сбрасываем состояние игры
  room.gameState = null;
}

function broadcastToRoom(roomId, message) {
  const room = gameRooms[roomId];
  if (!room) return;
  
  room.players.forEach(playerId => {
    const session = playerSessions[playerId];
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        ...message,
        players: room.players
      }));
    }
  });
}

function determineCombination(hand) {
  if (!hand || hand.length !== 5) return 'Старшая карта';
  
  const ranksCount = {};
  const suitsCount = {};
  const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  
  hand.forEach(card => {
    ranksCount[card.rank] = (ranksCount[card.rank] || 0) + 1;
    suitsCount[card.suit] = (suitsCount[card.suit] || 0) + 1;
  });
  
  const isFlush = Object.values(suitsCount).some(count => count === 5);
  const uniqueRanks = Object.keys(ranksCount);
  const isStraight = checkStraight(hand.map(card => card.rank), rankOrder);
  
  const pairs = Object.values(ranksCount).filter(count => count === 2).length;
  const threeOfAKind = Object.values(ranksCount).some(count => count === 3);
  const fourOfAKind = Object.values(ranksCount).some(count => count === 4);
  
  // Проверка комбинаций от самой сильной к самой слабой
  if (isStraight && isFlush && hand.some(card => card.rank === 'A') && hand.some(card => card.rank === 'K')) {
    return 'Роял-флэш';
  }
  if (isStraight && isFlush) {
    return 'Стрит-флэш';
  }
  if (fourOfAKind) {
    return 'Каре';
  }
  if (threeOfAKind && pairs === 1) {
    return 'Фулл-хаус';
  }
  if (isFlush) {
    return 'Флэш';
  }
  if (isStraight) {
    return 'Стрит';
  }
  if (threeOfAKind) {
    return 'Тройка';
  }
  if (pairs === 2) {
    return 'Две пары';
  }
  if (pairs === 1) {
    return 'Пара';
  }
  return 'Старшая карта';
}

function checkStraight(ranks, rankOrder) {
  const uniqueRanks = [...new Set(ranks)]
    .sort((a, b) => rankOrder.indexOf(a) - rankOrder.indexOf(b));
  
  if (uniqueRanks.length !== 5) return false;
  
  // Обычный стрит
  for (let i = 0; i < uniqueRanks.length - 1; i++) {
    if (rankOrder.indexOf(uniqueRanks[i+1]) - rankOrder.indexOf(uniqueRanks[i]) !== 1) {
      // Специальный случай: стрит с тузом как 1 (A-2-3-4-5)
      if (uniqueRanks.join('') === 'A2345') return true;
      return false;
    }
  }
  return true;
}

function getCombinationRank(combo) {
  const comboOrder = [
    'Старшая карта',
    'Пара',
    'Две пары',
    'Тройка',
    'Стрит',
    'Флэш',
    'Фулл-хаус',
    'Каре',
    'Стрит-флэш',
    'Роял-флэш'
  ];
  return comboOrder.indexOf(combo);
}

server.listen(10000, () => {
  console.log('Server started on port 10000');
});