// server.js
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory storage (in a real app, use a database)
const users = new Map(); // userId -> { ws, username }
const friends = new Map(); // userId -> [friendUserId]
const pendingRequests = new Map(); // userId -> [{ fromUserId, fromUsername }]

// WebSocket connection
wss.on('connection', (ws) => {
  let userId = null;
  let username = null;

  // Handle messages
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    switch(data.type) {
      case 'auth':
        // Authenticate user
        userId = data.userId;
        username = data.username;
        
        users.set(userId, { ws, username });
        
        // Send pending friend requests
        if (pendingRequests.has(userId)) {
          ws.send(JSON.stringify({
            type: 'friend_requests',
            requests: pendingRequests.get(userId)
          }));
        }
        
        // Send friends list
        sendFriendsList(userId);
        
        // Notify friends about online status
        notifyFriendsOnline(userId, true);
        break;
        
      case 'add_friend':
        // Handle friend request
        handleAddFriend(userId, username, data.username);
        break;
        
      case 'accept_friend':
        // Accept friend request
        handleAcceptFriend(userId, data.userId);
        break;
        
      case 'reject_friend':
        // Reject friend request
        handleRejectFriend(userId, data.userId);
        break;
        
      case 'chat_message':
        // Forward chat message
        forwardChatMessage(userId, data.toUserId, data.message);
        break;
    }
  });
  
  // Handle connection close
  ws.on('close', () => {
    if (userId) {
      users.delete(userId);
      notifyFriendsOnline(userId, false);
    }
  });
});

function handleAddFriend(fromUserId, fromUsername, toUsername) {
  // Find user by username
  let toUserId = null;
  users.forEach((user, id) => {
    if (user.username === toUsername) {
      toUserId = id;
    }
  });
  
  if (toUserId) {
    // Add to pending requests
    if (!pendingRequests.has(toUserId)) {
      pendingRequests.set(toUserId, []);
    }
    
    pendingRequests.get(toUserId).push({
      fromUserId,
      fromUsername
    });
    
    // Notify recipient if online
    const recipient = users.get(toUserId);
    if (recipient) {
      recipient.ws.send(JSON.stringify({
        type: 'friend_request',
        fromUserId,
        fromUsername
      }));
    }
  }
}

function handleAcceptFriend(userId, friendUserId) {
  // Add to friends list for both users
  addFriend(userId, friendUserId);
  addFriend(friendUserId, userId);
  
  // Remove from pending requests
  if (pendingRequests.has(userId)) {
    pendingRequests.set(userId, 
      pendingRequests.get(userId).filter(req => req.fromUserId !== friendUserId)
    );
  }
  
  // Notify both users
  sendFriendsList(userId);
  sendFriendsList(friendUserId);
}

function addFriend(userId, friendUserId) {
  if (!friends.has(userId)) {
    friends.set(userId, []);
  }
  
  if (!friends.get(userId).includes(friendUserId)) {
    friends.get(userId).push(friendUserId);
  }
}

function sendFriendsList(userId) {
  const user = users.get(userId);
  if (user) {
    const friendsList = friends.get(userId) || [];
    
    user.ws.send(JSON.stringify({
      type: 'friends_list',
      friends: friendsList.map(friendId => {
        const friend = users.get(friendId);
        return {
          id: friendId,
          name: friend ? friend.username : 'Unknown',
          online: !!users.get(friendId)
        };
      })
    }));
  }
}

function notifyFriendsOnline(userId, isOnline) {
  const friendIds = friends.get(userId) || [];
  
  friendIds.forEach(friendId => {
    const friend = users.get(friendId);
    if (friend) {
      friend.ws.send(JSON.stringify({
        type: isOnline ? 'friend_online' : 'friend_offline',
        userId
      }));
    }
  });
}

function forwardChatMessage(fromUserId, toUserId, message) {
  const sender = users.get(fromUserId);
  const recipient = users.get(toUserId);
  
  if (recipient) {
    recipient.ws.send(JSON.stringify({
      type: 'chat_message',
      fromUserId,
      fromUsername: sender.username,
      message,
      timestamp: new Date().toISOString()
    }));
  }
}

server.listen(3000, () => {
  console.log('Server started on port 3000');
});