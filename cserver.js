const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

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


// Получение списка друзей (аналог /api/get-friends/:userId)
app.get('/api/friends', (req, res) => {
    const userId = req.query.userId; // или из тела запроса
    const friendsList = friends.get(userId) || [];
    res.json({ friends: Array.from(friendsList) });
});

// Получение списка групп
app.get('/api/groups', (req, res) => {
    const userId = req.query.userId;
    const userGroups = Array.from(groups.values())
        .filter(group => group.members.includes(userId));
    res.json({ groups: userGroups });
});

// Получение списка чатов
app.get('/api/chats', (req, res) => {
    const userId = req.query.userId;
    const userChats = Array.from(chatHistory.keys())
        .filter(key => key.includes(userId));
    res.json({ chats: userChats });
});

app.post('/api/add-friend', (req, res) => {
    const { userId, friendId } = req.body;
    
    if (!users.has(friendId)) {
        return res.status(404).json({ success: false, message: "Пользователь не найден" });
    }

    if (!friendRequests.has(friendId)) {
        friendRequests.set(friendId, new Set());
    }
    friendRequests.get(friendId).add(uuidv4());

    res.json({ success: true, message: "Запрос в друзья отправлен" });
});

app.post('/api/accept-friend', (req, res) => {
    const { userId, requestId } = req.body;
    
    if (!friendRequests.has(userId) || !friendRequests.get(userId).has(requestId)) {
        return res.status(404).json({ success: false, message: "Запрос не найден" });
    }

    if (!friends.has(userId)) {
        friends.set(userId, new Set());
    }
    friends.get(userId).add(req.body.friendId);

    friendRequests.get(userId).delete(requestId);
    res.json({ success: true, message: "Пользователь добавлен в друзья" });
});

app.post('/api/create-group', (req, res) => {
    const { userId, name, members } = req.body;
    const groupId = uuidv4();
    
    groups.set(groupId, {
        name,
        members: [...members, userId],
        createdAt: Date.now()
    });

    res.json({ success: true, groupId });
});

app.post('/api/send-message', (req, res) => {
    const { chatId, senderId, text } = req.body;
    
    if (!messages.has(chatId)) {
        messages.set(chatId, []);
    }
    
    const message = {
        id: uuidv4(),
        senderId,
        text,
        timestamp: Date.now()
    };
    
    messages.get(chatId).push(message);
    res.json({ success: true, message });
});

app.get('/api/get-friends/:userId', (req, res) => {
    const friendsList = friends.get(req.params.userId) || [];
    res.json({ success: true, friends: Array.from(friendsList) });
});

app.get('/api/get-messages/:chatId', (req, res) => {
    const chatMessages = messages.get(req.params.chatId) || [];
    res.json({ success: true, messages: chatMessages });
});


const server = http.createServer(app);

// WebSocket-сервер
const wss = new WebSocket.Server({ server });

// Хранилища данных в памяти
const users = new Map();       // userId -> { ws, username, level, score }
const messages = new Map();    // userId -> [{ fromUserId, fromUsername, text, timestamp }]
const chatHistory = new Map(); // Для хранения истории чатов
const friendRequests = new Map(); // для /api/add-friend
const friends = new Map();        // для /api/accept-friend
const groups = new Map(); 

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