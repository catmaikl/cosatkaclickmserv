const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Настройки CORS для Socket.IO
const io = socketIo(server, {
    cors: {
        origin: "https://cosatka-clickgame-277-p2.netlify.app/",
        methods: ["GET", "POST"]
    }
});

// Раздаем статические файлы из текущей директории
app.use(express.static(path.join(__dirname)));

// Отправляем index.html для корневого пути
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Данные игроков
let players = [];
// Активные бои
let activeBattles = [];

// Обработка подключений
io.on('connection', (socket) => {
    console.log('Новый игрок подключился:', socket.id);

    // Обработчик присоединения игрока
    socket.on('player-join', (playerData) => {
        // Проверяем, нет ли уже игрока с таким именем
        const existingPlayerIndex = players.findIndex(p => p.name === playerData.name);

        if (existingPlayerIndex !== -1) {
            // Если игрок с таким именем уже есть, обновляем его данные
            players[existingPlayerIndex] = {
                ...players[existingPlayerIndex],
                id: socket.id,
                resources: playerData.resources || 0,
                clickPower: playerData.clickPower || 1,
                autoPower: playerData.autoPower || 0
            };
        } else {
            // Добавляем нового игрока в список
            const player = {
                id: socket.id,
                name: playerData.name,
                resources: playerData.resources || 0,
                clickPower: playerData.clickPower || 1,
                autoPower: playerData.autoPower || 0,
                health: 100
            };

            players.push(player);
        }

        // Отправляем обновленный список игроков всем
        io.emit('players-list', players);

        // Уведомляем о новом игроке
        socket.broadcast.emit('player-joined', playerData);

        console.log(`Игрок ${playerData.name} присоединился к игре`);
    });

    // Обработчик клика по кошке
    socket.on('player-mine', (data) => {
        const playerIndex = players.findIndex(p => p.name === data.name);
        if (playerIndex !== -1) {
            players[playerIndex].resources += data.mined;
            io.emit('players-list', players);
        }
    });

    // Обработчик обновления данных игрока
    socket.on('player-update', (playerData) => {
        const playerIndex = players.findIndex(p => p.name === playerData.name);
        if (playerIndex !== -1) {
            players[playerIndex].resources = playerData.resources;
            players[playerIndex].clickPower = playerData.clickPower;
            players[playerIndex].autoPower = playerData.autoPower;

            io.emit('players-list', players);
        }
    });

    // Обработчик сообщений чата
    socket.on('chat-message', (data) => {
        if (isValidMessage(data.message)) {
            io.emit('chat-message', data);
        } else {
            socket.emit('chat-message', {
                sender: 'Система',
                message: 'Ваше сообщение содержит запрещенный контент.'
            });
        }
    });

    // Обработчик вызова на бой
    socket.on('battle-challenge', (data) => {
        const defender = players.find(p => p.name === data.defender);
        const challenger = players.find(p => p.name === data.challenger);

        if (!defender || !challenger) {
            socket.emit('battle-error', { message: 'Игрок не найден' });
            return;
        }

        // Проверяем, не участвует ли уже игрок в бою
        const existingBattle = activeBattles.find(b => 
            b.players.includes(data.challenger) || b.players.includes(data.defender)
        );

        if (existingBattle) {
            socket.emit('battle-error', { message: 'Один из игроков уже в бою' });
            return;
        }

        const defenderSocket = findSocketByPlayerName(data.defender);
        if (defenderSocket) {
            defenderSocket.emit('battle-challenge', {
                challenger: data.challenger,
                defender: data.defender
            });
        }
    });

    // Обработчик принятия боя
    socket.on('battle-accept', (data) => {
        const challengerSocket = findSocketByPlayerName(data.challenger);
        if (challengerSocket) {
            // Создаем новый бой
            const battle = {
                id: Date.now().toString(),
                players: [data.challenger, data.defender],
                health: {
                    [data.challenger]: 100,
                    [data.defender]: 100
                },
                turn: data.challenger // Первым ходит вызывающий
            };

            activeBattles.push(battle);

            challengerSocket.emit('battle-started', battle);
            socket.emit('battle-started', battle);

            io.emit('chat-message', {
                sender: 'Система',
                message: `Начался бой между ${data.challenger} и ${data.defender}!`
            });
        }
    });

    // Обработчик отклонения боя
    socket.on('battle-decline', (data) => {
        const challengerSocket = findSocketByPlayerName(data.challenger);
        if (challengerSocket) {
            challengerSocket.emit('battle-declined', data);
        }
    });

    // Обработчик атаки в бою
    socket.on('battle-attack', (data) => {
        const battle = activeBattles.find(b => 
            b.players.includes(data.attacker) && b.players.includes(data.defender)
        );

        if (!battle) {
            socket.emit('battle-error', { message: 'Бой не найден' });
            return;
        }

        if (battle.turn !== data.attacker) {
            socket.emit('battle-error', { message: 'Сейчас не ваш ход' });
            return;
        }

        // Применяем урон
        battle.health[data.defender] -= data.damage;
        if (battle.health[data.defender] < 0) battle.health[data.defender] = 0;

        // Меняем ход
        battle.turn = data.defender;

        // Отправляем результат атаки обоим игрокам
        const attackerSocket = findSocketByPlayerName(data.attacker);
        const defenderSocket = findSocketByPlayerName(data.defender);

        if (attackerSocket) {
            attackerSocket.emit('battle-update', battle);
        }
        if (defenderSocket) {
            defenderSocket.emit('battle-update', battle);
        }

        // Проверяем конец боя
        if (battle.health[data.defender] <= 0) {
            endBattle(battle, data.attacker, data.defender);
        }
    });

    // Обработчик отключения игрока
    socket.on('disconnect', () => {
        const playerIndex = players.findIndex(p => p.id === socket.id);

        if (playerIndex !== -1) {
            const disconnectedPlayer = players[playerIndex];

            // Завершаем все бои с участием отключившегося игрока
            const playerBattles = activeBattles.filter(b => b.players.includes(disconnectedPlayer.name));
            playerBattles.forEach(battle => {
                const winner = battle.players.find(p => p !== disconnectedPlayer.name);
                if (winner) {
                    endBattle(battle, winner, disconnectedPlayer.name);
                }
            });

            players.splice(playerIndex, 1);

            io.emit('players-list', players);
            io.emit('player-left', disconnectedPlayer);

            console.log(`Игрок ${disconnectedPlayer.name} покинул игру`);
        }
    });
});

// Завершение боя
function endBattle(battle, winner, loser) {
    // Награждаем победителя
    const winnerPlayer = players.find(p => p.name === winner);
    if (winnerPlayer) {
        winnerPlayer.resources += 50;
        winnerPlayer.health = 100;
    }

    // Восстанавливаем здоровье проигравшего
    const loserPlayer = players.find(p => p.name === loser);
    if (loserPlayer) {
        loserPlayer.health = 100;
    }

    // Удаляем бой из активных
    activeBattles = activeBattles.filter(b => b.id !== battle.id);

    // Уведомляем всех о результате
    io.emit('battle-ended', { winner, loser, battle });
    io.emit('players-list', players);
    io.emit('chat-message', {
        sender: 'Система',
        message: `Бой завершен! ${winner} победил ${loser} и получил 50 рыбок!`
    });
}

// Поиск сокета по имени игрока
function findSocketByPlayerName(playerName) {
    const player = players.find(p => p.name === playerName);
    if (player) {
        return io.sockets.sockets.get(player.id);
    }
    return null;
}

// Проверка сообщения на валидность
function isValidMessage(message) {
    if (message.length > 200) return false;
    const forbiddenWords = ['спам', 'оскорбление', 'реклама'];
    for (let word of forbiddenWords) {
        if (message.toLowerCase().includes(word)) return false;
    }
    return true;
}

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Откройте браузер и перейдите по адресу: http://localhost:${PORT}`);
});