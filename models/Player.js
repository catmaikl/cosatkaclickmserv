const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  score: { type: Number, default: 0 },
  perclick: { type: Number, default: 1 },
  persecond: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  totalClicks: { type: Number, default: 0 },
  achievements: { type: Object, default: {} },
  skills: { type: Object, default: {} },
  inventory: { type: Object, default: {} },
  lastOnline: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Player', playerSchema);
