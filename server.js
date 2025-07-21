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

// Константы игры
const SUITS = ['♥', '♦', '♣', '♠'];
const VALUES = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Класс карты
class Card {
  constructor(suit, value) {
    this.suit = suit;
    this.value = value;
  }

  // Сравнение карт (для защиты)
  canBeat(attackCard, trumpSuit) {
    if (this.suit === attackCard.suit) {
      return VALUES.indexOf(this.value) > VALUES.indexOf(attackCard.value);
    }
    return this.suit === trumpSuit && attackCard.suit !== trumpSuit;
  }
}

// Класс комнаты
class Room {
  constructor(id, name, creator) {
    this.id = id;
    this.name = name;
    this.players = [creator];
    this.gameStarted = false;
    this.deck = [];
    this.table = [];
    this.trump = null;
    this.attackerIndex = 0;
    this.defenderIndex = 1;
    this.currentTurn = null;
    this.canPass = false;
  }

  // Инициализация игры
  startGame() {
    this.gameStarted = true;
    
    // Создаем колоду и перемешиваем
    this.deck = [];
    for (const suit of SUITS) {
      for (const value of VALUES) {
        this.deck.push(new Card(suit, value));
      }
    }
    this.shuffleDeck();
    
    // Определяем козырь
    this.trump = this.deck[this.deck.length - 1];
    
    // Раздаем карты игрокам (по 6 каждому)
    this.players.forEach(player => {
      player.cards = this.dealCards(6);
    });
    
    // Первый атакующий - игрок с младшим козырем
    this.determineFirstAttacker();
    
    // Устанавливаем текущий ход
    this.currentTurn = this.players[this.attackerIndex].id;
    this.canPass = false;
  }

  // Перемешивание колоды
  shuffleDeck() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  // Раздача карт
  dealCards(count) {
    return this.deck.splice(0, count);
  }

  // Определение первого атакующего (по младшему козырю)
  determineFirstAttacker() {
    let minTrumpValue = Infinity;
    
    this.players.forEach((player, index) => {
      player.cards.forEach(card => {
        if (card.suit === this.trump.suit) {
          const valueIndex = VALUES.indexOf(card.value);
          if (valueIndex < minTrumpValue) {
            minTrumpValue = valueIndex;
            this.attackerIndex = index;
            this.defenderIndex = (index + 1) % this.players.length;
          }
        }
      });
    });
  }

  // Атака картой
  attack(playerId, cardIndices) {
    if (this.currentTurn !== playerId || !this.gameStarted) return false;
    
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;
    
    // Проверяем, что игрок атакующий
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex !== this.attackerIndex) return false;
    
    // Проверяем выбранные карты
    const cardsToPlay = cardIndices.map(i => player.cards[i]).filter(card => card);
    if (cardsToPlay.length === 0) return false;
    
    // Для первой атаки можно положить любые карты
    if (this.table.length === 0) {
      // Удаляем карты из руки игрока
      cardIndices.sort((a, b) => b - a).forEach(i => {
        player.cards.splice(i, 1);
      });
      
      // Добавляем карты на стол
      cardsToPlay.forEach(card => {
        this.table.push({ attack: card, defend: null });
      });
      
      // Передаем ход защитнику
      this.currentTurn = this.players[this.defenderIndex].id;
      return true;
    }
    
    // Для последующих атак карты должны совпадать по значению с картами на столе
    const tableValues = this.table.map(pair => pair.attack.value);
    if (cardsToPlay.some(card => !tableValues.includes(card.value))) {
      return false;
    }
    
    // Удаляем карты из руки игрока
    cardIndices.sort((a, b) => b - a).forEach(i => {
      player.cards.splice(i, 1);
    });
    
    // Добавляем карты на стол
    cardsToPlay.forEach(card => {
      this.table.push({ attack: card, defend: null });
    });
    
    return true;
  }

  // Защита картой
  defend(playerId, cardIndex) {
      if (this.currentTurn !== playerId || !this.gameStarted) return false;

      const player = this.players.find(p => p.id === playerId);
      if (!player || !player.cards[cardIndex]) return false;

      // Проверяем, что игрок защитник
      const playerIndex = this.players.findIndex(p => p.id === playerId);
      if (playerIndex !== this.defenderIndex) return false;

      // Находим первую неотбитую карту
      const undefendedPair = this.table.find(pair => !pair.defend);
      if (!undefendedPair) return false;

      // Проверяем карту
      const defendingCard = player.cards[cardIndex];

      if (defendingCard.canBeat(undefendedPair.attack, this.trump.suit)) {
          // Удаляем карту из руки игрока
          player.cards.splice(cardIndex, 1);

          // Устанавливаем защитную карту
          undefendedPair.defend = defendingCard;

          // Проверяем, все ли карты отбиты
          if (this.table.every(pair => pair.defend)) {
              this.completeRound();
          }

          return true;
      }

      return false;
  }

  // Взять карты
  takeCards(playerId) {
    if (this.currentTurn !== playerId || !this.gameStarted) return false;
    
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;
    
    // Проверяем, что игрок защитник
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex !== this.defenderIndex) return false;
    
    // Берем все карты со стола
    this.table.forEach(pair => {
      player.cards.push(pair.attack);
      if (pair.defend) {
        player.cards.push(pair.defend);
      }
    });
    
    this.table = [];
    
    // Переход хода
    this.nextRound(false);
    return true;
  }

  // Пасс (передать ход)
  pass(playerId) {
    if (!this.canPass || this.currentTurn !== playerId || !this.gameStarted) return false;
    
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;
    
    // Проверяем, что игрок атакующий
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex !== this.attackerIndex) return false;
    
    // Завершаем раунд
    this.completeRound();
    return true;
  }

  // Завершение раунда (успешная защита)
  completeRound() {
    // Очищаем стол
    this.table = [];
    
    // Добираем карты
    this.players.forEach(player => {
      while (player.cards.length < 6 && this.deck.length > 0) {
        player.cards.push(this.deck.shift());
      }
    });
    
    // Переход хода
    this.nextRound(true);
  }

  // Следующий раунд
  nextRound(successfulDefense) {
    if (successfulDefense) {
      // Защитник становится атакующим
      this.attackerIndex = this.defenderIndex;
    }
    
    // Следующий игрок становится защитником
    this.defenderIndex = (this.attackerIndex + 1) % this.players.length;
    
    // Устанавливаем текущий ход
    this.currentTurn = this.players[this.attackerIndex].id;
    this.canPass = false;
    
    // Проверка конца игры
    this.checkGameEnd();
  }

  // Проверка окончания игры
  checkGameEnd() {
    // Если у защитника нет карт - он выиграл
    const defender = this.players[this.defenderIndex];
    if (defender.cards.length === 0 && this.deck.length === 0) {
      this.endGame(defender.id);
      return;
    }
    
    // Если у атакующего нет карт - защитник проиграл
    const attacker = this.players[this.attackerIndex];
    if (attacker.cards.length === 0 && this.deck.length === 0) {
      this.endGame(attacker.id);
      return;
    }
  }

  // Окончание игры
  endGame(winnerId) {
    this.gameStarted = false;
    
    // Отправляем результат игрокам
    this.players.forEach(player => {
      io.to(player.id).emit('game_over', player.id === winnerId ? 'win' : 'lose');
    });
  }

  // Получить состояние игры для игрока
  getPlayerState(playerId) {
      const playerIndex = this.players.findIndex(p => p.id === playerId);
      if (playerIndex === -1) return null;

      const opponentIndex = (playerIndex + 1) % this.players.length;
      const opponent = this.players[opponentIndex];

      return {
          yourCards: this.players[playerIndex].cards,
          opponentCardsCount: opponent ? opponent.cards.length : 0,
          table: this.table.filter(pair => pair.attack), // Фильтруем null значения
          trump: this.trump,
          deckCount: this.deck.length,
          isAttacker: this.attackerIndex === playerIndex && this.currentTurn === playerId,
          isDefender: this.defenderIndex === playerIndex && this.currentTurn === playerId,
          canPass: this.canPass && this.attackerIndex === playerIndex && this.table.length > 0,
          players: this.players
    };
  }
}

// Хранилище комнат
const rooms = new Map();

// Обработка подключений
io.on('connection', (socket) => {
  console.log(`Новое подключение: ${socket.id}`);
  
  // Создание комнаты
  socket.on('create_room', ({ name, playerName }) => {
    if (rooms.size < 100) { // Ограничение на количество комнат
      const roomId = generateRoomId();
      const room = new Room(roomId, name, { id: socket.id, name: playerName });
      rooms.set(roomId, room);
      
      socket.join(roomId);
      socket.emit('room_created', { id: roomId, name });
      
      updateRoomsList();
    }
  });
  
  // Присоединение к комнате
      socket.on('join_room', (roomId, playerName) => {
        const room = rooms.get(roomId);
        if (room && room.players.length < 2) {
            room.players.push({ 
                id: socket.id, 
                name: playerName || `Игрок ${room.players.length + 1}` 
            });
            socket.join(roomId);

            socket.emit('room_joined', { 
                id: room.id, 
                name: room.name,
                players: room.players
            });
      
      // Если комната заполнена - начинаем игру
      if (room.players.length === 2) {
        room.startGame();
        io.to(room.id).emit('game_started', {
          players: room.players,
          trump: room.trump,
          deckCount: room.deck.length
        });
        
        // Отправляем состояние игры каждому игроку
        room.players.forEach(player => {
          io.to(player.id).emit('game_update', room.getPlayerState(player.id));
        });
      }
      
      updateRoomsList();
    }
  });
  
  // Запрос списка комнат
  socket.on('get_rooms', () => {
    updateRoomsList();
  });
  
  // Игрок делает ход (атака)
  socket.on('play_cards', ({ type, cardIndices }) => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    
    let success = false;
    if (type === 'attack') {
      success = room.attack(socket.id, cardIndices);
    } else if (type === 'defend') {
      success = room.defend(socket.id, cardIndices[0]);
    }
    
    if (success) {
      // Отправляем обновленное состояние всем игрокам в комнате
      room.players.forEach(player => {
        io.to(player.id).emit('game_update', room.getPlayerState(player.id));
      });
      
      // Проверяем конец игры
      room.checkGameEnd();
    }
  });
  
  // Игрок берет карты
  socket.on('take_cards', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    
    const success = room.takeCards(socket.id);
    if (success) {
      room.players.forEach(player => {
        io.to(player.id).emit('game_update', room.getPlayerState(player.id));
      });
      
      room.checkGameEnd();
    }
  });
  
  // Игрок делает пасс
  socket.on('pass', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    
    const success = room.pass(socket.id);
    if (success) {
      room.players.forEach(player => {
        io.to(player.id).emit('game_update', room.getPlayerState(player.id));
      });
      
      room.checkGameEnd();
    }
  });
  
  // Игрок покидает комнату
  socket.on('leave_room', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    
    // Удаляем игрока из комнаты
    room.players = room.players.filter(player => player.id !== socket.id);
    socket.leave(room.id);
    
    // Если в комнате остался 1 игрок - уведомляем его
    if (room.players.length === 1) {
      io.to(room.players[0].id).emit('player_left');
    }
    
    // Если комната пуста - удаляем ее
    if (room.players.length === 0) {
      rooms.delete(room.id);
    }
    
    updateRoomsList();
  });
  
  // Отключение игрока
  socket.on('disconnect', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    
    // Удаляем игрока из комнаты
    room.players = room.players.filter(player => player.id !== socket.id);
    
    // Если в комнате остался 1 игрок - уведомляем его
    if (room.players.length === 1) {
      io.to(room.players[0].id).emit('player_left');
    }
    
    // Если комната пуста - удаляем ее
    if (room.players.length === 0) {
      rooms.delete(room.id);
    }
    
    updateRoomsList();
  });
});

// Вспомогательные функции
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function findPlayerRoom(playerId) {
  for (const room of rooms.values()) {
    if (room.players.some(player => player.id === playerId)) {
      return room;
    }
  }
  return null;
}

function updateRoomsList() {
  const roomsList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    gameStarted: room.gameStarted
  }));
  
  io.emit('rooms_list', roomsList);
}

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});