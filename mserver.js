const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Game state
const battles = {};
const players = {};
const matchmakingQueue = [];

// Generate unique IDs
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// Matchmaking
function findOpponent(playerId) {
  if (matchmakingQueue.length > 0 && matchmakingQueue[0] !== playerId) {
    return matchmakingQueue.shift();
  }
  return null;
}

// Battle logic
function startBattle(player1, player2) {
  const battleId = generateId();
  const battle = {
    id: battleId,
    players: [player1, player2],
    scores: { [player1]: 0, [player2]: 0 },
    cps: { [player1]: 0, [player2]: 0 },
    timeLeft: 30,
    active: true,
  };

  battles[battleId] = battle;

  // Notify both players
  players[player1].send(
    JSON.stringify({
      type: "battle_start",
      battleId,
      opponent: players[player2].username,
      opponentLevel: players[player2].level,
    })
  );

  players[player2].send(
    JSON.stringify({
      type: "battle_start",
      battleId,
      opponent: players[player1].username,
      opponentLevel: players[player1].level,
    })
  );

  // Start battle timer
  const timer = setInterval(() => {
    battle.timeLeft--;

    // Рассылаем обновления всем игрокам
    battle.players.forEach((playerId) => {
      if (players[playerId]) {
        players[playerId].send(
          JSON.stringify({
            type: "battle_update",
            timeLeft: battle.timeLeft,
            yourScore: battle.scores[playerId],
            opponentScore:
              battle.scores[
                playerId === battle.players[0]
                  ? battle.players[1]
                  : battle.players[0]
              ],
            yourCps: battle.cps[playerId],
            opponentCps:
              battle.cps[
                playerId === battle.players[0]
                  ? battle.players[1]
                  : battle.players[0]
              ],
          })
        );
      }
    });

    if (battle.timeLeft <= 0) {
      clearInterval(timer);
      endBattle(battleId);
    }
  }, 1000);
}

function endBattle(battleId) {
  const battle = battles[battleId];
  if (!battle) return;

  battle.active = false;
  const [player1, player2] = battle.players;
  const winner =
    battle.scores[player1] > battle.scores[player2]
      ? player1
      : battle.scores[player1] < battle.scores[player2]
      ? player2
      : null;

  // Notify players
  if (players[player1]) {
    players[player1].send(
      JSON.stringify({
        type: "battle_end",
        winner:
          winner === player1 ? "you" : winner === player2 ? "opponent" : "draw",
        yourScore: battle.scores[player1],
        opponentScore: battle.scores[player2],
        reward: winner === player1 ? 50 : winner === player2 ? 20 : 30,
      })
    );
  }

  if (players[player2]) {
    players[player2].send(
      JSON.stringify({
        type: "battle_end",
        winner:
          winner === player2 ? "you" : winner === player1 ? "opponent" : "draw",
        yourScore: battle.scores[player2],
        opponentScore: battle.scores[player1],
        reward: winner === player2 ? 50 : winner === player1 ? 20 : 30,
      })
    );
  }

  delete battles[battleId];
}

// WebSocket connection
wss.on("connection", (ws) => {
  const playerId = generateId();
  players[playerId] = ws;

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "register":
          // Register player
          players[playerId].username = data.username;
          players[playerId].level = data.level;
          break;

        case "find_battle":
          // Add to matchmaking
          const opponentId = findOpponent(playerId);
          if (opponentId) {
            startBattle(playerId, opponentId);
          } else {
            matchmakingQueue.push(playerId);
            ws.send(JSON.stringify({ type: "searching" }));
          }
          break;

        case 'battle_click':
    if (data.battleId && battles[data.battleId] && battles[data.battleId].active) {
        const battle = battles[data.battleId];
        battle.scores[playerId] += data.value || 1;
        
        // Calculate CPS
        const now = Date.now();
        if (!battle.lastClick) battle.lastClick = {};
        if (!battle.clickCount) battle.clickCount = {};
        
        if (!battle.lastClick[playerId] || now - battle.lastClick[playerId] > 1000) {
            battle.lastClick[playerId] = now;
            battle.clickCount[playerId] = 0;
        }
        
        battle.clickCount[playerId]++;
        battle.cps[playerId] = battle.clickCount[playerId] / ((now - battle.lastClick[playerId] + 1) / 1000);
        
        // Немедленно уведомляем всех игроков об изменении
        battle.players.forEach(pId => {
            if (players[pId]) {
                players[pId].send(JSON.stringify({
                    type: 'battle_update',
                    timeLeft: battle.timeLeft,
                    yourScore: battle.scores[pId],
                    opponentScore: battle.scores[pId === battle.players[0] ? battle.players[1] : battle.players[0]],
                    yourCps: battle.cps[pId],
                    opponentCps: battle.cps[pId === battle.players[0] ? battle.players[1] : battle.players[0]]
                }));
            }
        });
    }
    break;

        case "cancel_search":
          // Remove from matchmaking
          const index = matchmakingQueue.indexOf(playerId);
          if (index !== -1) matchmakingQueue.splice(index, 1);
          break;
      }
    } catch (e) {
      console.error("Error processing message:", e);
    }
  });

  ws.on("close", () => {
    // Clean up
    delete players[playerId];
    const index = matchmakingQueue.indexOf(playerId);
    if (index !== -1) matchmakingQueue.splice(index, 1);
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
