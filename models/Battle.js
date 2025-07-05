const mongoose = require('mongoose');

const playerStatsSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  score: { type: Number, default: 0 },
  cps: { type: Number, default: 0 }
});

const battleSchema = new mongoose.Schema({
  battleId: { type: String, required: true, unique: true },
  mode: { type: String, enum: ['random', 'friend'], required: true },
  players: [playerStatsSchema],
  startTime: { type: Date },
  duration: { type: Number, default: 30000 }, // 30 секунд
  status: { type: String, enum: ['waiting', 'active', 'finished'], default: 'waiting' },
  winner: { type: String },
  createdAt: { type: Date, default: Date.now }
});

battleSchema.index({ battleId: 1 });
battleSchema.index({ status: 1 });
battleSchema.index({ 'players.userId': 1 });

module.exports = mongoose.model('Battle', battleSchema);
