const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// WebSocket-сервер
const wss = new WebSocket.Server({ server });

// Хранилища данных
const users = new Map(); // userId -> { ws, username, level, score }
const messages = new Map(); // userId -> [{ toUserId, text, timestamp }]

wss.on("connection", (ws) => {
    let userId = null;
    console.log('Новое подключение WebSocket');

    ws.on("message", (message) => {
        console.log('Получено:', message);
        
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case "auth":
                    handleAuth(ws, data);
                    break;
                case "chat_message":
                    handleChatMessage(data);
                    break;
                case "get_messages":
                    sendMessagesHistory(userId, data.withUserId);
                    break;
                default:
                    console.warn('Неизвестный тип сообщения:', data.type);
            }
        } catch (e) {
            console.error('Ошибка обработки сообщения:', e);
        }
    });

    ws.on("close", () => {
        if (userId) {
            users.delete(userId);
        }
    });

    function handleAuth(ws, data) {
        userId = data.userId;
        users.set(userId, {
            ws,
            username: data.username,
            level: data.level || 1,
            score: data.score || 0,
        });
        
        // Отправляем непрочитанные сообщения
        if (messages.has(userId)) {
            const unread = messages.get(userId);
            unread.forEach(msg => {
                ws.send(JSON.stringify({
                    type: "chat_message",
                    fromUserId: msg.fromUserId,
                    fromUsername: msg.fromUsername,
                    message: msg.text,
                    timestamp: msg.timestamp
                }));
            });
            messages.delete(userId);
        }
    }

    function handleChatMessage(data) {
        const recipient = users.get(data.toUserId);
        const sender = users.get(data.userId);
        
        if (!sender) return;

        const messageData = {
            fromUserId: data.userId,
            fromUsername: sender.username,
            text: data.message,
            timestamp: Date.now()
        };

        // Если получатель онлайн, отправляем сообщение
        if (recipient) {
            recipient.ws.send(JSON.stringify({
                type: "chat_message",
                ...messageData
            }));
            
            // Подтверждение отправки
            sender.ws.send(JSON.stringify({
                type: "message_delivered",
                messageId: data.messageId,
                timestamp: Date.now()
            }));
        } else {
            // Если оффлайн, сохраняем сообщение
            if (!messages.has(data.toUserId)) {
                messages.set(data.toUserId, []);
            }
            messages.get(data.toUserId).push(messageData);
        }
    }

    function sendMessagesHistory(userId, withUserId) {
        const user = users.get(userId);
        if (!user) return;

        // В реальном приложении здесь бы брали историю из БД
        const history = [
            {
                text: "Привет! Как дела?",
                fromUserId: withUserId,
                fromUsername: "Друг",
                timestamp: Date.now() - 3600000,
                isOutgoing: false
            },
            {
                text: "Привет! Все отлично, а у тебя?",
                fromUserId: userId,
                fromUsername: user.username,
                timestamp: Date.now() - 1800000,
                isOutgoing: true
            }
        ];

        user.ws.send(JSON.stringify({
            type: "messages_history",
            messages: history,
            withUserId: withUserId
        }));
    }
});

server.listen(3000, () => {
    console.log("Server started on port 3000");
});
