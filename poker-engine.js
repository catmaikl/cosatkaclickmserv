class PokerEngine {
  constructor() {
      this.players = new Map();
      this.gameState = {
          stage: 'waiting', // waiting, preflop, flop, turn, river, showdown
          players: [],
          communityCards: [],
          pot: 0,
          currentBet: 0,
          dealerPosition: 0,
          currentPlayer: null,
          smallBlind: 10,
          bigBlind: 20
      };
  }

  joinGame(ws, username) {
      if (this.gameState.stage !== 'waiting') {
          ws.send(JSON.stringify({
              type: 'error',
              message: 'Game already in progress'
          }));
          return;
      }

      if (this.players.size >= 6) {
          ws.send(JSON.stringify({
              type: 'error',
              message: 'Table is full'
          }));
          return;
      }

      this.players.set(ws, {
          username,
          chips: 1000,
          cards: [],
          folded: false,
          bet: 0
      });

      this.broadcastGameState();
  }

  startGame(ws) {
      if (this.gameState.stage !== 'waiting' || this.players.size < 2) {
          ws.send(JSON.stringify({
              type: 'error',
              message: 'Cannot start game'
          }));
          return;
      }

      // Initialize game
      this.gameState.stage = 'preflop';
      this.gameState.players = Array.from(this.players.values());
      this.gameState.communityCards = [];
      this.gameState.pot = 0;
      this.gameState.currentBet = this.gameState.bigBlind;
      this.gameState.dealerPosition = (this.gameState.dealerPosition + 1) % this.players.size;

      // Deal cards and collect blinds
      this.dealCards();
      this.collectBlinds();

      this.broadcastGameState();
  }

  dealCards() {
      // Simplified card dealing
      const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
      const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

      // Generate deck
      let deck = [];
      for (let suit of suits) {
          for (let value of values) {
              deck.push({ suit, value });
          }
      }

      // Shuffle deck
      deck = deck.sort(() => Math.random() - 0.5);

      // Deal to players
      for (let player of this.gameState.players) {
          player.cards = [deck.pop(), deck.pop()];
          player.folded = false;
          player.bet = 0;
      }

      // Set dealer, small blind and big blind positions
      const sbPos = (this.gameState.dealerPosition + 1) % this.players.size;
      const bbPos = (this.gameState.dealerPosition + 2) % this.players.size;

      this.gameState.currentPlayer = (this.gameState.dealerPosition + 3) % this.players.size;
  }

  collectBlinds() {
      const sbPlayer = this.gameState.players[
          (this.gameState.dealerPosition + 1) % this.players.size
      ];
      const bbPlayer = this.gameState.players[
          (this.gameState.dealerPosition + 2) % this.players.size
      ];

      sbPlayer.chips -= this.gameState.smallBlind;
      sbPlayer.bet = this.gameState.smallBlind;

      bbPlayer.chips -= this.gameState.bigBlind;
      bbPlayer.bet = this.gameState.bigBlind;

      this.gameState.pot = this.gameState.smallBlind + this.gameState.bigBlind;
      this.gameState.currentBet = this.gameState.bigBlind;
  }

  playerAction(ws, action, amount = 0) {
      const player = this.players.get(ws);
      if (!player || this.gameState.stage === 'waiting') return;

      if (this.gameState.players[this.gameState.currentPlayer] !== player) {
          ws.send(JSON.stringify({
              type: 'error',
              message: 'Not your turn'
          }));
          return;
      }

      switch (action) {
          case 'fold':
              player.folded = true;
              this.nextPlayer();
              break;

          case 'check':
              if (player.bet < this.gameState.currentBet) {
                  ws.send(JSON.stringify({
                      type: 'error',
                      message: 'Cannot check, bet is higher'
                  }));
                  return;
              }
              this.nextPlayer();
              break;

          case 'call':
              const callAmount = this.gameState.currentBet - player.bet;
              player.chips -= callAmount;
              player.bet += callAmount;
              this.gameState.pot += callAmount;
              this.nextPlayer();
              break;

          case 'raise':
              if (amount <= this.gameState.currentBet) {
                  ws.send(JSON.stringify({
                      type: 'error',
                      message: 'Raise amount must be higher than current bet'
                  }));
                  return;
              }
              const raiseAmount = amount - player.bet;
              player.chips -= raiseAmount;
              player.bet = amount;
              this.gameState.pot += raiseAmount;
              this.gameState.currentBet = amount;
              this.nextPlayer();
              break;
      }

      this.checkRoundCompletion();
      this.broadcastGameState();
  }

  nextPlayer() {
      do {
          this.gameState.currentPlayer = 
              (this.gameState.currentPlayer + 1) % this.players.size;
      } while (this.gameState.players[this.gameState.currentPlayer].folded);
  }

  checkRoundCompletion() {
      // Check if all players have acted
      const activePlayers = this.gameState.players.filter(p => !p.folded);

      if (activePlayers.length === 1) {
          // Only one player left - they win
          this.endGame(activePlayers[0]);
          return;
      }

      const allActed = activePlayers.every(p => 
          p.bet === this.gameState.currentBet || p.chips === 0
      );

      if (allActed) {
          this.advanceGameStage();
      }
  }

  advanceGameStage() {
      switch (this.gameState.stage) {
          case 'preflop':
              this.gameState.stage = 'flop';
              this.dealCommunityCards(3);
              break;

          case 'flop':
              this.gameState.stage = 'turn';
              this.dealCommunityCards(1);
              break;

          case 'turn':
              this.gameState.stage = 'river';
              this.dealCommunityCards(1);
              break;

          case 'river':
              this.gameState.stage = 'showdown';
              this.determineWinner();
              break;
      }

      // Reset bets for new round
      this.gameState.currentBet = 0;
      for (let player of this.gameState.players) {
          player.bet = 0;
      }

      // Set first player to act (left of dealer)
      this.gameState.currentPlayer = 
          (this.gameState.dealerPosition + 1) % this.players.size;
  }

  dealCommunityCards(count) {
      // Simplified - in real game should use remaining deck
      const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
      const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

      for (let i = 0; i < count; i++) {
          this.gameState.communityCards.push({
              suit: suits[Math.floor(Math.random() * suits.length)],
              value: values[Math.floor(Math.random() * values.length)]
          });
      }
  }

  determineWinner() {
      // Simplified winner determination
      // In real game would need to evaluate poker hands
      const activePlayers = this.gameState.players.filter(p => !p.folded);
      const winner = activePlayers[Math.floor(Math.random() * activePlayers.length)];

      winner.chips += this.gameState.pot;
      this.endGame(winner);
  }

  endGame(winner) {
      this.broadcast({
          type: 'game_over',
          winner: winner.username,
          pot: this.gameState.pot
      });

      // Reset game state
      this.gameState = {
          stage: 'waiting',
          players: [],
          communityCards: [],
          pot: 0,
          currentBet: 0,
          dealerPosition: (this.gameState.dealerPosition + 1) % this.players.size,
          currentPlayer: null,
          smallBlind: 10,
          bigBlind: 20
      };

      // Reset player states
      for (let player of Array.from(this.players.values())) {
          player.cards = [];
          player.folded = false;
          player.bet = 0;
      }

      this.broadcastGameState();
  }

  leaveGame(ws) {
      const player = this.players.get(ws);
      if (!player) return;

      this.players.delete(ws);

      if (this.gameState.stage !== 'waiting') {
          // If game is in progress, treat as fold
          player.folded = true;
          this.checkRoundCompletion();
      } else {
          // If in waiting, just update player list
          this.gameState.players = this.gameState.players.filter(p => p !== player);
      }

      this.broadcastGameState();
  }

  broadcastGameState() {
      const gameStateForPlayers = {
          ...this.gameState,
          players: this.gameState.players.map(player => ({
              username: player.username,
              chips: player.chips,
              bet: player.bet,
              folded: player.folded,
              cards: player === this.gameState.players[this.gameState.currentPlayer] ? 
                  player.cards : null
          })),
          currentPlayer: this.gameState.currentPlayer
      };

      this.broadcast({
          type: 'game_state',
          gameState: gameStateForPlayers
      });
  }

  broadcast(message) {
      const jsonMessage = JSON.stringify(message);
      this.players.forEach((_, ws) => {
          if (ws.readyState === WebSocket.OPEN) {
              ws.send(jsonMessage);
          }
      });
  }
}

module.exports = PokerEngine;