const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();

app.use((req, res, next) => {
  const allowedOrigins = [
    'https://cosatka-clickgame-277.netlify.app',
    'http://localhost:3000'
  ];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', true);
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

const server = http.createServer(app);

// WebSocket-сервер
const wss = new WebSocket.Server({ server });

// Хранилища данных в памяти
const users = new Map();       // userId -> { ws, username, level, score }
const messages = new Map();    // userId -> [{ fromUserId, fromUsername, text, timestamp }]
const chatHistory = new Map(); // Для хранения истории чатов

wss.on("connection", (ws) => {
    let userId = null;
    console.log('Новое подключение WebSocket');

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Получено:', data.type);

            switch (data.type) {
                case "auth":
                    handleAuth(ws, data);
                    break;
                case "chat_message":
                    handleChatMessage(data);
                    break;
                case "get_history":
                    handleGetHistory(data);
                    break;
                case "get_online_users":
                    handleGetOnlineUsers(data);
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
            console.log(`Пользователь ${userId} отключился`);
            notifyUsersAboutStatus();
        }
    });

    function handleAuth(ws, data) {
        userId = data.userId;
        users.set(userId, {
            ws,
            username: data.username,
            level: data.level || 1,
            score: data.score || 0,
            lastSeen: null
        });

        // Отправляем непрочитанные сообщения
        deliverPendingMessages(userId);
        
        // Уведомляем о новом пользователе
        notifyUsersAboutStatus();
        
        ws.send(JSON.stringify({
            type: "auth_success",
            message: "Аутентификация успешна"
        }));
    }

    function handleChatMessage(data) {
        const sender = users.get(data.userId);
        if (!sender) return;

        const message = {
            fromUserId: data.userId,
            fromUsername: sender.username,
            text: data.message,
            timestamp: Date.now(),
            isDelivered: false
        };

        // Сохраняем в историю
        saveToHistory(data.userId, data.toUserId, message);
        saveToHistory(data.toUserId, data.userId, message);

        // Если получатель онлайн, отправляем сообщение
        const recipient = users.get(data.toUserId);
        if (recipient) {
            recipient.ws.send(JSON.stringify({
                type: "chat_message",
                ...message,
                isDelivered: true
            }));
            
            // Подтверждение отправителю
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
            messages.get(data.toUserId).push(message);
        }
    }

    function handleGetHistory(data) {
        const user = users.get(data.userId);
        if (!user) return;

        const history = getHistory(data.userId, data.withUserId) || [];
        user.ws.send(JSON.stringify({
            type: "chat_history",
            messages: history,
            withUserId: data.withUserId
        }));
    }

    function handleGetOnlineUsers(data) {
        const user = users.get(data.userId);
        if (!user) return;

        const onlineUsers = Array.from(users.values())
            .filter(u => u.username && u.username !== user.username)
            .map(u => ({
                userId: u.userId,
                username: u.username,
                level: u.level,
                score: u.score
            }));

        user.ws.send(JSON.stringify({
            type: "online_users",
            users: onlineUsers
        }));
    }

    function deliverPendingMessages(userId) {
        if (messages.has(userId)) {
            const pendingMessages = messages.get(userId);
            const user = users.get(userId);
            
            if (user) {
                pendingMessages.forEach(msg => {
                    user.ws.send(JSON.stringify({
                        type: "chat_message",
                        ...msg,
                        isDelivered: true
                    }));
                });
                messages.delete(userId);
            }
        }
    }

    function saveToHistory(user1, user2, message) {
        const key = `${user1}-${user2}`;
        if (!chatHistory.has(key)) {
            chatHistory.set(key, []);
        }
        chatHistory.get(key).push(message);
        
        // Ограничиваем историю последними 100 сообщениями
        if (chatHistory.get(key).length > 100) {
            chatHistory.set(key, chatHistory.get(key).slice(-100));
        }
    }

    function getHistory(user1, user2) {
        const key1 = `${user1}-${user2}`;
        const key2 = `${user2}-${user1}`;
        
        return [
            ...(chatHistory.get(key1) || []),
            ...(chatHistory.get(key2) || [])
        ].sort((a, b) => a.timestamp - b.timestamp);
    }

    function notifyUsersAboutStatus() {
        const onlineUsers = Array.from(users.values())
            .map(u => ({
                userId: u.userId,
                username: u.username,
                isOnline: true
            }));

        users.forEach(user => {
            if (user.ws.readyState === WebSocket.OPEN) {
                user.ws.send(JSON.stringify({
                    type: "users_status",
                    users: onlineUsers
                }));
            }
        });
    }
});

// HTTP endpoint для проверки работы сервера
app.get('/status', (req, res) => {
    res.json({
        status: 'ok',
        usersOnline: users.size,
        messagesInQueue: Array.from(messages.values()).reduce((acc, msgs) => acc + msgs.length, 0)
    });
});

server.listen(3000, () => {
    console.log("Сервер запущен на порту 3000");
    console.log("WebSocket endpoint: ws://localhost:3000");
    console.log("HTTP endpoint: http://localhost:3000/status");
});
