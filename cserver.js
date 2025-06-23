// server.js
const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid');

// HTTP сервер
const server = http.createServer();
const port = process.env.PORT || 10000;

// WebSocket сервер для чата
const wssChat = new WebSocket.Server({ noServer: true });

// Хранилище данных
const chatState = {
  users: new Map(), // Map<userId, {ws, username, ...}>
  messages: [],     // История сообщений (последние 100)
};

// Обработчики сообщений чата
const chatMessageHandlers = {
  register: handleRegister,
  chat_message: handleChatMessage,
};

// Запуск сервера
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/chat') {
    wssChat.handleUpgrade(request, socket, head, (ws) => {
      wssChat.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Обработка подключений к чату
wssChat.on('connection', (ws, request) => {
  console.log('Новое подключение к чату');
  
  ws.userId = null;
  ws.username = null;

  ws.on('message', (rawData) => {
    try {
      const data = JSON.parse(rawData);
      const handler = chatMessageHandlers[data.type];
      
      if (handler) {
        handler(ws, data);
      } else {
        sendError(ws, 'unknown_message_type', 'Неизвестный тип сообщения');
      }
    } catch (err) {
      console.error('Ошибка обработки сообщения:', err);
      sendError(ws, 'invalid_message', 'Некорректное сообщение');
    }
  });

  ws.on('close', () => {
    handleUserDisconnected(ws);
  });
});

// Обработчики сообщений
function handleRegister(ws, data) {
  if (!data.username || typeof data.username !== 'string') {
    return sendError(ws, 'invalid_username', 'Неверное имя пользователя');
  }

  const userId = data.userId || uuid.v4();
  const username = data.username.trim().substring(0, 20);
  
  // Проверяем, не занято ли имя
  for (const [_, user] of chatState.users) {
    if (user.username === username) {
      return sendError(ws, 'username_taken', 'Это имя уже занято');
    }
  }

  ws.userId = userId;
  ws.username = username;

  // Добавляем пользователя
  chatState.users.set(userId, {
    ws,
    userId,
    username,
    joinedAt: Date.now()
  });

  // Отправляем историю сообщений
  ws.send(JSON.stringify({
    type: 'history',
    messages: chatState.messages.slice(-100) // Последние 100 сообщений
  }));

  // Уведомляем всех о новом пользователе
  broadcast({
    type: 'user_joined',
    userId,
    username,
    timestamp: Date.now()
  }, ws);

  console.log(`Пользователь ${username} (${userId}) присоединился к чату`);
}

function handleChatMessage(ws, data) {
  if (!ws.userId || !ws.username) {
    return sendError(ws, 'not_authenticated', 'Сначала зарегистрируйтесь');
  }

  if (!data.message || typeof data.message !== 'string') {
    return sendError(ws, 'invalid_message', 'Некорректное сообщение');
  }

  // Ограничение длины сообщения
  const message = data.message.trim().substring(0, 200);
  if (message.length === 0) {
    return sendError(ws, 'empty_message', 'Сообщение не может быть пустым');
  }

  const messageData = {
    type: 'chat_message',
    userId: ws.userId,
    username: ws.username,
    message,
    timestamp: Date.now()
  };

  // Сохраняем в историю
  chatState.messages.push(messageData);
  if (chatState.messages.length > 1000) {
    chatState.messages = chatState.messages.slice(-1000); // Ограничиваем историю
  }

  // Рассылаем всем
  broadcast(messageData);
}

function handleUserDisconnected(ws) {
  if (!ws.userId) return;

  const user = chatState.users.get(ws.userId);
  if (!user) return;

  chatState.users.delete(ws.userId);
  
  // Уведомляем всех об отключении
  broadcast({
    type: 'user_left',
    userId: ws.userId,
    username: user.username,
    timestamp: Date.now()
  });

  console.log(`Пользователь ${user.username} (${ws.userId}) покинул чат`);
}

// Вспомогательные функции
function broadcast(data, excludeWs = null) {
  wssChat.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function sendError(ws, code, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'error',
      code,
      message,
      timestamp: Date.now()
    }));
  }
}

// Запуск сервера
server.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
  console.log(`WebSocket чат доступен по адресу ws://localhost:${port}/chat`);
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
  console.error('Необработанное исключение:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанный промис:', err);
});