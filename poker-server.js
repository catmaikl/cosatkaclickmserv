const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const PokerEngine = require('./poker-engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const pokerEngine = new PokerEngine();

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.action) {
            case 'join':
                pokerEngine.joinGame(ws, data.username);
                break;

            case 'start':
                pokerEngine.startGame(ws);
                break;

            case 'fold':
                pokerEngine.playerAction(ws, 'fold');
                break;

            case 'check':
                pokerEngine.playerAction(ws, 'check');
                break;

            case 'call':
                pokerEngine.playerAction(ws, 'call');
                break;

            case 'raise':
                pokerEngine.playerAction(ws, 'raise', data.amount);
                break;

            case 'leave':
                pokerEngine.leaveGame(ws);
                break;
        }
    });

    ws.on('close', () => {
        pokerEngine.leaveGame(ws);
    });
});