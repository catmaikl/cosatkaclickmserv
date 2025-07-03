const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

const users = new Map(); // Store users with their WebSocket connections
const messagesHistory = new Map();
const groups = new Map();

wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.type === 'message') {
            // Сохраняем сообщение в историю
            const chatKey = [data.from, data.to].sort().join('_');
            if (!messagesHistory.has(chatKey)) {
                messagesHistory.set(chatKey, []);
            }
            messagesHistory.get(chatKey).push({
                from: data.from,
                text: data.text,
                timestamp: new Date().toISOString()
            });

            // Отправка сообщения получателю
            const recipient = users.get(data.to);
            if (recipient) {
                recipient.send(JSON.stringify({
                    type: 'message',
                    from: data.from,
                    text: data.text,
                    timestamp: new Date().toISOString()
                }));
            }
        }
        
        switch (data.type) {
            case 'login':
                users.set(data.username, ws);
                broadcastUserList();
                console.log(`${data.username} logged in`);
                break;
                
            case 'message':
                const recipient = users.get(data.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: 'message',
                        from: data.from,
                        text: data.text,
                        timestamp: new Date().toISOString()
                    }));
                }
                break;

            case 'file_upload':
                const recipient2 = users.get(data.to);
                if (recipient2) {
                    recipient2.send(JSON.stringify({
                        type: 'file_message',
                        from: data.from,
                        fileName: data.fileName,
                        fileType: data.fileType,
                        fileData: data.fileData,
                        timestamp: new Date().toISOString()
                    }));
                }
                break;

            case 'get_users':
                ws.send(JSON.stringify({
                    type: 'user_list',
                    users: Array.from(users.keys()).filter(user => user !== data.username)
                }));
                break;

            // Модифицируем обработку истории сообщений для групп
            case 'get_history':
                const chatKey2 = data.withUser.startsWith('group_') 
                    ? data.withUser 
                    : [data.username, data.withUser].sort().join('_');
                    
                if (messagesHistory.has(chatKey2)) {
                    ws.send(JSON.stringify({
                        type: 'history',
                        messages: messagesHistory.get(chatKey2),
                        withUser: data.withUser
                    }));
                }
                break;

            case 'typing':
                const recipient3 = users.get(data.to);
                if (recipient3) {
                    recipient3.send(JSON.stringify({
                        type: 'typing_notification',
                        from: data.from,
                        isTyping: data.isTyping
                    }));
                }
                break;

            // Добавляем новые case в обработчик сообщений
            case 'create_group':
                const groupId = `group_${Date.now()}`;
                groups.set(groupId, {
                    name: data.groupName,
                    members: data.members,
                    creator: data.username
                });
                // Уведомляем участников
                data.members.forEach(member => {
                    const memberWs = users.get(member);
                    if (memberWs) {
                        memberWs.send(JSON.stringify({
                            type: 'group_created',
                            groupId: groupId,
                            groupName: data.groupName,
                            creator: data.username
                        }));
                    }
                });
                break;
                
            case 'group_message':
                const group = groups.get(data.groupId);
                if (group && group.members.includes(data.from)) {
                    // Сохраняем в историю
                    if (!messagesHistory.has(data.groupId)) {
                        messagesHistory.set(data.groupId, []);
                    }
                    messagesHistory.get(data.groupId).push({
                        from: data.from,
                        text: data.text,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Рассылаем участникам
                    group.members.forEach(member => {
                        if (member !== data.from) {
                            const memberWs = users.get(member);
                            if (memberWs) {
                                memberWs.send(JSON.stringify({
                                    type: 'group_message',
                                    groupId: data.groupId,
                                    from: data.from,
                                    text: data.text,
                                    timestamp: new Date().toISOString()
                                }));
                            }
                        }
                    });
                }
                break;

            case 'get_history':
                const chatKey = [data.username, data.withUser].sort().join('_');
                if (messagesHistory.has(chatKey)) {
                    ws.send(JSON.stringify({
                        type: 'history',
                        messages: messagesHistory.get(chatKey),
                        withUser: data.withUser
                    }));
                }
                break;
                
            case 'logout':
                users.delete(data.username);
                broadcastUserList();
                console.log(`${data.username} logged out`);
                break;
        }
    });
    
    ws.on('close', () => {
        // Find and remove the disconnected user
        for (let [username, connection] of users.entries()) {
            if (connection === ws) {
                users.delete(username);
                broadcastUserList();
                console.log(`${username} disconnected`);
                break;
            }
        }
    });
});

function broadcastUserList() {
    const userList = Array.from(users.keys());
    const message = JSON.stringify({
        type: 'userlist',
        users: userList
    });
    
    // Send to all connected clients
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}