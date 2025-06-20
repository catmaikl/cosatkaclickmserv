// server.js
const WebSocket = require("ws");
const http = require("http");
const express = require("express");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилища данных
const users = new Map(); // userId -> { ws, username, level, score }
const friends = new Map(); // userId -> [friendUserId]
const pendingRequests = new Map(); // userId -> [{ fromUserId, fromUsername }]
const groups = new Map(); // groupId -> { name, members, messages }

wss.on("connection", (ws) => {
    let userId = null;

    ws.on("message", (message) => {
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
        }
    });

    ws.on("close", () => {
        if (userId) {
            users.delete(userId);
            notifyFriendsStatus(userId, false);
        }
    });

    function handleAuth(ws, data) {
        userId = data.userId;
        users.set(userId, {
            ws,
            username: data.username,
            level: data.level,
            score: data.score,
        });

        // Отправляем pending requests
        if (pendingRequests.has(userId)) {
            ws.send(
                JSON.stringify({
                    type: "friend_requests",
                    requests: pendingRequests.get(userId),
                })
            );
        }

        // Отправляем список друзей
        sendFriendsList(userId);

        // Уведомляем друзей о подключении
        notifyFriendsStatus(userId, true);
    }

    function handleRejectFriend(data) {
        if (pendingRequests.has(data.userId)) {
            pendingRequests.set(
                data.userId,
                pendingRequests
                    .get(data.userId)
                    .filter((req) => req.fromUserId !== data.friendId)
            );
        }
    }

    function handleChatMessage(data) {
        // Проверяем, есть ли получатель
        const recipient = users.get(data.toUserId);
        if (!recipient) return;

        // Проверяем, есть ли отправитель
        const sender = users.get(data.userId);
        if (!sender) return;

        // Отправляем сообщение получателю
        recipient.ws.send(JSON.stringify({
            type: "chat_message",
            fromUserId: data.userId,
            fromUsername: sender.username,
            message: data.message,
            timestamp: Date.now()
        }));

        // Сохраняем сообщение в истории (если есть группа)
        if (data.groupId) {
            if (!groups.has(data.groupId)) {
                groups.set(data.groupId, {
                    name: "",
                    members: [],
                    messages: []
                });
            }
            groups.get(data.groupId).messages.push({
                from: data.userId,
                message: data.message,
                timestamp: Date.now()
            });
        }
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
                if (recipient.score === undefined) recipient.score = 0;
                recipient.score += 100;
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
            // Добавляем запрос
            if (!pendingRequests.has(toUserId)) {
                pendingRequests.set(toUserId, []);
            }

            pendingRequests.get(toUserId).push({
                fromUserId: data.userId,
                fromUsername: fromUser.username,
            });

            // Уведомляем получателя, если онлайн
            const recipient = users.get(toUserId);
            if (recipient) {
                recipient.ws.send(
                    JSON.stringify({
                        type: "friend_request",
                        fromUserId: data.userId,
                        fromUsername: fromUser.username,
                    })
                );
            }
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
                pendingRequests
                    .get(data.userId)
                    .filter((req) => req.fromUserId !== data.friendId)
            );
        }

        // Уведомляем обоих пользователей
        updateFriendsLists([data.userId, data.friendId]);
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

        user.ws.send(
            JSON.stringify({
                type: "friends_list",
                friends: friendsList.map((friendId) => {
                    const friend = users.get(friendId);
                    return {
                        id: friendId,
                        name: friend ? friend.username : "Unknown",
                        level: friend ? friend.level : 0,
                        online: !!users.get(friendId),
                        lastSeen: users.get(friendId) ? null : Date.now(),
                    };
                }),
            })
        );
    }

    function notifyFriendsStatus(userId, isOnline) {
        const friendIds = friends.get(userId) || [];
        const status = isOnline ? "online" : "offline";
        const lastSeen = isOnline ? null : Date.now();

        friendIds.forEach((friendId) => {
            const friend = users.get(friendId);
            if (friend) {
                friend.ws.send(
                    JSON.stringify({
                        type: "friend_status",
                        userId,
                        status,
                        lastSeen,
                    })
                );
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
});

server.listen(3000, () => {
    console.log("Server started on port 3000");
});