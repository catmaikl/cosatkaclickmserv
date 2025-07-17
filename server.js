const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Игровые константы
const MIN_BET = 10;
const MAX_BET = 500;
const START_CHIPS = 1000;

// Хранилище игроков
const players = new Map();

// Колода карт
const suits = ['♥', '♦', '♣', '♠'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Создание новой колоды
function createDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value });
    }
  }
  return shuffleDeck(deck);
}

// Перемешивание колоды
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Подсчет очков в руке
function calculateScore(cards) {
  let score = 0;
  let aces = 0;
  
  for (const card of cards) {
    if (['J', 'Q', 'K'].includes(card.value)) {
      score += 10;
    } else if (card.value === 'A') {
      score += 11;
      aces++;
    } else {
      score += parseInt(card.value);
    }
  }
  
  while (score > 21 && aces > 0) {
    score -= 10;
    aces--;
  }
  
  return score;
}

// Инициализация нового игрока
function initPlayer(socketId) {
  return {
    socketId,
    chips: START_CHIPS,
    artifacts: 0,
    bet: 0,
    multiplier: 1,
    deck: [],
    playerCards: [],
    dealerCards: [],
    gameActive: false
  };
}

// Обработка подключений
io.on('connection', (socket) => {
  console.log(`Новое подключение: ${socket.id}`);
  
  // Инициализация игрока
  if (!players.has(socket.id)) {
    players.set(socket.id, initPlayer(socket.id));
  }
  
  // Отправка текущего состояния
  socket.emit('player_state', players.get(socket.id));
  
  // Обработка начала игры
  socket.on('start_game', ({ bet, multiplier }) => {
    const player = players.get(socket.id);
    
    // Проверка ставки
    if (bet < MIN_BET || bet > MAX_BET || bet > player.chips) {
      socket.emit('error', 'Недопустимая ставка');
      return;
    }
    
    // Подготовка игры
    player.bet = bet;
    player.multiplier = multiplier;
    player.chips -= bet;
    player.deck = createDeck();
    player.playerCards = [player.deck.pop(), player.deck.pop()];
    player.dealerCards = [player.deck.pop(), player.deck.pop()];
    player.gameActive = true;
    
    // Проверка на блэкджек
    const playerScore = calculateScore(player.playerCards);
    if (playerScore === 21) {
      endGame(socket, 'blackjack');
      return;
    }
    
    // Обновление состояния
    socket.emit('game_state', {
      chips: player.chips,
      bet: player.bet,
      playerCards: player.playerCards,
      dealerCards: player.dealerCards,
      playerScore,
      gameActive: true
    });
  });
  
  // Обработка действий игрока
  socket.on('player_action', (action) => {
    const player = players.get(socket.id);
    
    if (!player.gameActive) return;
    
    switch (action) {
      case 'hit':
        // Взять карту
        player.playerCards.push(player.deck.pop());
        const playerScore = calculateScore(player.playerCards);
        
        if (playerScore > 21) {
          endGame(socket, 'bust');
        } else {
          socket.emit('game_state', {
            playerCards: player.playerCards,
            playerScore,
            gameActive: true
          });
        }
        break;
        
      case 'stand':
        // Закончить ход
        player.gameActive = false;
        dealerTurn(socket, player);
        break;
        
      case 'double':
        // Удвоить ставку
        if (player.chips >= player.bet) {
          player.chips -= player.bet;
          player.bet *= 2;
          player.playerCards.push(player.deck.pop());
          const newScore = calculateScore(player.playerCards);
          
          if (newScore > 21) {
            endGame(socket, 'bust');
          } else {
            player.gameActive = false;
            dealerTurn(socket, player);
          }
        }
        break;
        
      case 'deal':
        // Новая раздача
        if (!player.gameActive) {
          if (player.chips >= player.bet) {
            player.chips -= player.bet;
            player.deck = createDeck();
            player.playerCards = [player.deck.pop(), player.deck.pop()];
            player.dealerCards = [player.deck.pop(), player.deck.pop()];
            player.gameActive = true;
            
            const playerScore = calculateScore(player.playerCards);
            if (playerScore === 21) {
              endGame(socket, 'blackjack');
              return;
            }
            
            socket.emit('game_state', {
              chips: player.chips,
              playerCards: player.playerCards,
              dealerCards: player.dealerCards,
              playerScore,
              gameActive: true
            });
          } else {
            socket.emit('error', 'Недостаточно фишек');
          }
        }
        break;
    }
  });
  
  // Ход дилера
  function dealerTurn(socket, player) {
    let dealerScore = calculateScore(player.dealerCards);
    
    // Дилер берет карты до 17
    while (dealerScore < 17) {
      player.dealerCards.push(player.deck.pop());
      dealerScore = calculateScore(player.dealerCards);
    }
    
    // Определение результата
    const playerScore = calculateScore(player.playerCards);
    let result;
    
    if (dealerScore > 21 || playerScore > dealerScore) {
      result = 'win';
    } else if (playerScore === dealerScore) {
      result = 'push';
    } else {
      result = 'lose';
    }
    
    endGame(socket, result);
  }
  
  // Завершение игры
  function endGame(socket, result) {
    const player = players.get(socket.id);
    player.gameActive = false;
    
    const dealerScore = calculateScore(player.dealerCards);
    const playerScore = calculateScore(player.playerCards);
    
    let title, message;
    let winAmount = 0;
    let artifactReward = 0;
    
    switch (result) {
      case 'blackjack':
        title = 'Блэкджек!';
        message = 'Вы выиграли с блэкджеком!';
        winAmount = Math.floor(player.bet * player.multiplier * 1.5);
        artifactReward = 1;
        break;
      case 'win':
        title = 'Победа!';
        message = `Вы выиграли ${winAmount} фишек!`;
        winAmount = player.bet * player.multiplier;
        artifactReward = 1;
        break;
      case 'push':
        title = 'Ничья';
        message = 'Ваша ставка возвращена';
        winAmount = player.bet;
        break;
      case 'lose':
        title = 'Проигрыш';
        message = `Вы проиграли ${player.bet} фишек`;
        break;
      case 'bust':
        title = 'Перебор';
        message = `Вы проиграли ${player.bet} фишек`;
        break;
    }
    
    // Начисление выигрыша
    player.chips += winAmount;
    
    // Начисление артефактов за победу
    if (result === 'win' || result === 'blackjack') {
      player.artifacts += artifactReward;
    }
    
    // Отправка результата
    socket.emit('game_result', {
      title,
      message,
      chips: player.chips,
      artifacts: player.artifacts,
      playerCards: player.playerCards,
      dealerCards: player.dealerCards,
      playerScore,
      dealerScore
    });
    
    // Обновление состояния
    players.set(socket.id, player);
  }
  
  // Отключение игрока
  socket.on('disconnect', () => {
    console.log(`Отключение: ${socket.id}`);
    players.delete(socket.id);
  });
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});