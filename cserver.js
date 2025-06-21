const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// WebSocket-сервер
const wss = new WebSocket.Server({ server });

// Хранилища данных
const users = new Map(); // userId -> { ws, username, level, score }
const friends = new Map(); // userId -> [friendUserId]
const pendingRequests = new Map(); // userId -> [{ fromUserId, fromUsername }]
const groups = new Map(); // groupId -> { name, members, messages }
const userSessions = new Map(); // userId -> { lastSeen }

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
                case "add_friend":
                    handleAddFriend(data);
                    break;
                case "accept_friend":
                    handleAcceptFriend(data);
                    break;
                case "reject_friend":
                    handleRejectFriend(data);
                    break;
                case "chat_message":
                    handleChatMessage(data);
                    break;
                case "send_gift":
                    handleSendGift(data);
                    break;
                case "voice_message":
                    handleVoiceMessage(data);
                    break;
                case "create_group":
                    handleCreateGroup(data);
                    break;
                case "start_minigame":
                    handleStartMiniGame(data);
                    break;
                case "get_friends":
                    sendFriendsList(userId);
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
            userSessions.set(userId, { lastSeen: Date.now() });
            users.delete(userId);
            notifyFriendsStatus(userId, false);
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

        // Обновляем сессию
        userSessions.set(userId, { lastSeen: null });

        // Отправляем pending requests
        if (pendingRequests.has(userId)) {
            ws.send(JSON.stringify({
                type: "friend_requests",
                requests: pendingRequests.get(userId),
            }));
        }

        // Отправляем список друзей
        sendFriendsList(userId);

        // Уведомляем друзей о подключении
        notifyFriendsStatus(userId, true);
    }

    function handleAddFriend(data) {
        const fromUser = users.get(data.userId);
        if (!fromUser) return;

        // Находим пользователя по username
        let toUserId = null;
        users.forEach((user, id) => {
            if (user.username === data.username && id !== data.userId) {
                toUserId = id;
            }
        });

        if (toUserId) {
            // Проверяем, не является ли уже другом
            if (friends.get(data.userId)?.includes(toUserId)) {
                fromUser.ws.send(JSON.stringify({
                    type: "friend_error",
                    message: "Этот пользователь уже у вас в друзьях"
                }));
                return;
            }

            // Проверяем, не отправлен ли уже запрос
            const existingRequests = pendingRequests.get(toUserId) || [];
            if (existingRequests.some(req => req.fromUserId === data.userId)) {
                fromUser.ws.send(JSON.stringify({
                    type: "friend_error",
                    message: "Вы уже отправили запрос этому пользователю"
                }));
                return;
            }

            // Добавляем запрос
            pendingRequests.set(toUserId, [
                ...existingRequests,
                {
                    fromUserId: data.userId,
                    fromUsername: fromUser.username,
                    timestamp: Date.now()
                }
            ]);

            // Уведомляем получателя, если онлайн
            const recipient = users.get(toUserId);
            if (recipient) {
                recipient.ws.send(JSON.stringify({
                    type: "friend_request",
                    fromUserId: data.userId,
                    fromUsername: fromUser.username,
                }));
            }

            fromUser.ws.send(JSON.stringify({
                type: "friend_success",
                message: "Запрос в друзья отправлен"
            }));
        } else {
            fromUser.ws.send(JSON.stringify({
                type: "friend_error",
                message: "Пользователь не найден или не в сети"
            }));
        }
    }

    function handleAcceptFriend(data) {
        // Добавляем взаимную дружбу
        addFriendship(data.userId, data.friendId);
        addFriendship(data.friendId, data.userId);

        // Удаляем запрос
        if (pendingRequests.has(data.userId)) {
            pendingRequests.set(
                data.userId,
                pendingRequests.get(data.userId)
                    .filter((req) => req.fromUserId !== data.friendId)
            );
        }

        // Уведомляем обоих пользователей
        updateFriendsLists([data.userId, data.friendId]);

        // Отправляем подтверждение
        const user = users.get(data.userId);
        if (user) {
            user.ws.send(JSON.stringify({
                type: "friend_accepted",
                friendId: data.friendId,
                friendName: users.get(data.friendId)?.username || "Unknown"
            }));
        }

        const friend = users.get(data.friendId);
        if (friend) {
            friend.ws.send(JSON.stringify({
                type: "friend_accepted",
                friendId: data.userId,
                friendName: user?.username || "Unknown"
            }));
        }
    }

    function handleRejectFriend(data) {
        if (pendingRequests.has(data.userId)) {
            pendingRequests.set(
                data.userId,
                pendingRequests.get(data.userId)
                    .filter((req) => req.fromUserId !== data.friendId)
            );
        }

        // Уведомляем отправителя об отклонении
        const friend = users.get(data.friendId);
        if (friend) {
            friend.ws.send(JSON.stringify({
                type: "friend_rejected",
                userId: data.userId
            }));
        }
    }

    function handleChatMessage(data) {
        // Проверяем, есть ли получатель
        const recipient = users.get(data.toUserId);
        if (!recipient) return;

        // Проверяем, есть ли отправитель
        const sender = users.get(data.userId);
        if (!sender) return;

        // Фильтрация сообщения
        const filteredMessage = filterMessage(data.message);

        // Отправляем сообщение получателю
        recipient.ws.send(JSON.stringify({
            type: "chat_message",
            fromUserId: data.userId,
            fromUsername: sender.username,
            message: filteredMessage,
            timestamp: Date.now()
        }));

        // Подтверждение отправки
        sender.ws.send(JSON.stringify({
            type: "message_delivered",
            messageId: data.messageId,
            timestamp: Date.now()
        }));
    }

    function handleSendGift(data) {
        // Проверяем получателя
        const recipient = users.get(data.toUserId);
        if (!recipient) return;

        // Проверяем отправителя
        const sender = users.get(data.userId);
        if (!sender) return;

        // Отправляем подарок
        recipient.ws.send(JSON.stringify({
            type: "receive_gift",
            fromUserId: data.userId,
            fromUsername: sender.username,
            gift: data.gift
        }));

        // Обрабатываем разные типы подарков
        switch (data.gift) {
            case "coins_100":
                // Получатель получает 100 косаток
                recipient.score = (recipient.score || 0) + 100;
                break;
            case "boost_1h":
                // Активируем буст на 1 час
                recipient.boost = {
                    active: true,
                    expires: Date.now() + 3600000 // 1 час  
                };
                break;
        }

        // Обновляем данные получателя
        users.set(data.toUserId, recipient);
    }

    function handleVoiceMessage(data) {
        const recipient = users.get(data.toUserId);
        if (!recipient) return;

        const sender = users.get(data.userId);
        if (!sender) return;

        recipient.ws.send(JSON.stringify({
            type: "voice_message",
            fromUserId: data.userId,
            fromUsername: sender.username,
            audioData: data.audioData,
            timestamp: Date.now()
        }));
    }

    function handleCreateGroup(data) {
        const groupId = `group_${Date.now()}`;
        groups.set(groupId, {
            name: data.groupName,
            members: [data.userId],
            messages: []
        });
        
        const user = users.get(data.userId);
        if (user) {
            user.ws.send(JSON.stringify({
                type: "group_created",
                groupId,
                groupName: data.groupName
            }));
        }
    }

    function handleStartMiniGame(data) {
        const recipient = users.get(data.toUserId);
        if (!recipient) return;

        const sender = users.get(data.userId);
        if (!sender) return;

        recipient.ws.send(JSON.stringify({
            type: "minigame_invite",
            fromUserId: data.userId,
            fromUsername: sender.username,
            gameType: data.gameType
        }));
    }

    function addFriendship(userId, friendId) {
        if (!friends.has(userId)) {
            friends.set(userId, []);
        }

        if (!friends.get(userId).includes(friendId)) {
            friends.get(userId).push(friendId);
        }
    }

    function sendFriendsList(userId) {
        const user = users.get(userId);
        if (!user) return;

        const friendsList = friends.get(userId) || [];
        const onlineFriends = [];
        const offlineFriends = [];

        friendsList.forEach(friendId => {
            const friend = users.get(friendId);
            const session = userSessions.get(friendId);
            
            if (friend) {
                onlineFriends.push({
                    id: friendId,
                    name: friend.username,
                    level: friend.level || 1,
                    online: true
                });
            } else if (session) {
                offlineFriends.push({
                    id: friendId,
                    name: "Unknown", // Можно хранить имена друзей отдельно
                    level: 1,
                    online: false,
                    lastSeen: session.lastSeen
                });
            }
        });

        user.ws.send(JSON.stringify({
            type: "friends_list",
            online: onlineFriends,
            offline: offlineFriends,
            pending: pendingRequests.get(userId) || []
        }));
    }

    function notifyFriendsStatus(userId, isOnline) {
        const friendIds = friends.get(userId) || [];
        const status = isOnline ? "online" : "offline";
        const lastSeen = isOnline ? null : Date.now();

        // Обновляем сессию
        userSessions.set(userId, { lastSeen });

        friendIds.forEach((friendId) => {
            const friend = users.get(friendId);
            if (friend) {
                friend.ws.send(JSON.stringify({
                    type: "friend_status",
                    userId,
                    status,
                    lastSeen,
                }));
            }
        });
    }

    function updateFriendsLists(userIds) {
        userIds.forEach((id) => {
            if (users.has(id)) {
                sendFriendsList(id);
            }
        });
    }

    function filterMessage(text) {
        // Простая фильтрация нецензурных слов
        const badWords = ['мат1', 'мат2', 'оскорбление'];
        return badWords.reduce((msg, word) => 
            msg.replace(new RegExp(word, 'gi'), '***'), text);
    }
});

server.listen(3000, () => {
    console.log("Server started on port 3000");
});