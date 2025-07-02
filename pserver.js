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
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(playerId, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });
  
  ws.on('close', () => {
    handleDisconnect(playerId);
  });
  
  // Отправляем приветственное сообщение
  ws.send(JSON.stringify({
    type: 'welcome',
    playerId,
    message: 'Добро пожаловать в покер!'
  }));
});

function generatePlayerId() {
  return Math.random().toString(36).substr(2, 9);
}

function handleMessage(playerId, data) {
  const session = playerSessions[playerId];
  if (!session) return;
  
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
    default:
      console.log('Unknown action:', data.action);
  }
}

function handleDisconnect(playerId) {
  const session = playerSessions[playerId];
  if (session && session.room) {
    leaveRoom(playerId);
  }
  delete playerSessions[playerId];
}

function createRoom(playerId, roomName) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    name: roomName,
    players: [playerId],
    gameState: null,
    deck: [],
    currentPlayer: null
  };
  
  gameRooms[roomId] = room;
  playerSessions[playerId].room = roomId;
  
  broadcastToRoom(roomId, {
    type: 'roomCreated',
    roomId,
    roomName,
    players: [playerId]
  });
}

function joinRoom(playerId, roomId) {
  const room = gameRooms[roomId];
  if (!room || room.players.length >= 4) return;
  
  room.players.push(playerId);
  playerSessions[playerId].room = roomId;
  
  broadcastToRoom(roomId, {
    type: 'playerJoined',
    playerId,
    players: room.players
  });
}

function leaveRoom(playerId) {
  const session = playerSessions[playerId];
  if (!session || !session.room) return;
  
  const roomId = session.room;
  const room = gameRooms[roomId];
  if (!room) return;
  
  room.players = room.players.filter(id => id !== playerId);
  session.room = null;
  
  if (room.players.length === 0) {
    delete gameRooms[roomId];
  } else {
    broadcastToRoom(roomId, {
      type: 'playerLeft',
      playerId,
      players: room.players
    });
  }
}

function startGame(roomId) {
  const room = gameRooms[roomId];
  if (!room || room.players.length < 2) return;
  
  room.deck = createDeck();
  shuffleDeck(room.deck);
  
  room.gameState = {
    phase: 'betting',
    players: room.players.map(playerId => ({
      id: playerId,
      hand: [],
      bet: 0,
      folded: false
    })),
    pot: 0,
    currentPlayer: 0
  };
  
  broadcastToRoom(roomId, {
    type: 'gameStarted',
    players: room.players,
    currentPlayer: room.players[0]
  });
}

function dealCards(roomId) {
  const room = gameRooms[roomId];
  if (!room || !room.gameState || room.gameState.phase !== 'betting') return;
  
  // Раздаем по 5 карт каждому игроку
  room.gameState.players.forEach(player => {
    player.hand = room.deck.splice(0, 5);
  });
  
  room.gameState.phase = 'drawing';
  
  broadcastToRoom(roomId, {
    type: 'cardsDealt',
    hands: room.gameState.players.map(player => ({
      playerId: player.id,
      cards: player.id === room.gameState.currentPlayer ? 
        player.hand : 
        Array(5).fill({ rank: 'back', suit: 'back' })
    })),
    currentPlayer: room.gameState.currentPlayer
  });
}

function handleBet(playerId, amount) {
  const session = playerSessions[playerId];
  if (!session || !session.room) return;
  
  const room = gameRooms[session.room];
  if (!room || !room.gameState) return;
  
  const player = room.gameState.players.find(p => p.id === playerId);
  if (!player) return;
  
  player.bet = amount;
  room.gameState.pot += amount;
  
  // Передаем ход следующему игроку
  const currentIndex = room.gameState.players.findIndex(p => p.id === playerId);
  const nextIndex = (currentIndex + 1) % room.gameState.players.length;
  room.gameState.currentPlayer = room.gameState.players[nextIndex].id;
  
  broadcastToRoom(room.id, {
    type: 'betPlaced',
    playerId,
    amount,
    pot: room.gameState.pot,
    currentPlayer: room.gameState.currentPlayer
  });
}

function handleDraw(playerId, cardsToReplace) {
  const session = playerSessions[playerId];
  if (!session || !session.room) return;
  
  const room = gameRooms[session.room];
  if (!room || !room.gameState || room.gameState.phase !== 'drawing') return;
  
  const player = room.gameState.players.find(p => p.id === playerId);
  if (!player) return;
  
  // Заменяем выбранные карты
  cardsToReplace.forEach(index => {
    if (room.deck.length > 0 && index >= 0 && index < player.hand.length) {
      player.hand[index] = room.deck.shift();
    }
  });
  
  // Проверяем, все ли игроки сделали замену
  const allPlayersDrew = room.gameState.players.every(p => 
    p.id === playerId || p.folded
  );
  
  if (allPlayersDrew) {
    endGame(room);
  } else {
    // Передаем ход следующему игроку
    const currentIndex = room.gameState.players.findIndex(p => p.id === playerId);
    const nextIndex = (currentIndex + 1) % room.gameState.players.length;
    room.gameState.currentPlayer = room.gameState.players[nextIndex].id;
    
    broadcastToRoom(room.id, {
      type: 'cardsDrawn',
      playerId,
      newCards: player.hand,
      currentPlayer: room.gameState.currentPlayer
    });
  }
}

function endGame(room) {
  // Определяем победителя
  const playersWithCombinations = room.gameState.players
    .filter(p => !p.folded)
    .map(player => ({
      ...player,
      combination: determineCombination(player.hand),
      combinationRank: getCombinationRank(determineCombination(player.hand))
    }));
  
  playersWithCombinations.sort((a, b) => b.combinationRank - a.combinationRank);
  const winner = playersWithCombinations[0];
  
  // Рассылаем результаты
  broadcastToRoom(room.id, {
    type: 'gameResult',
    winner: winner.id,
    winningCombination: winner.combination,
    pot: room.gameState.pot,
    allHands: room.gameState.players.map(player => ({
      playerId: player.id,
      cards: player.hand,
      combination: determineCombination(player.hand)
    }))
  });
  
  // Сбрасываем состояние игры
  room.gameState = null;
}

function broadcastToRoom(roomId, message) {
  const room = gameRooms[roomId];
  if (!room) return;
  
  room.players.forEach(playerId => {
    const session = playerSessions[playerId];
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(message));
    }
  });
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

function determineCombination(hand) {
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