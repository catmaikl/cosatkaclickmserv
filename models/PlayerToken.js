// models/PlayerToken.js
const mongoose = require('mongoose');

const PlayerTokenSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  token: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: '7d' } // Автоматическое удаление через 7 дней
});

module.exports = mongoose.model('PlayerToken', PlayerTokenSchema);
