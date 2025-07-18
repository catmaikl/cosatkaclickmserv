const mongoose = require('mongoose');

const leaderboardEntrySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  score: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

leaderboardEntrySchema.index({ score: -1 });
leaderboardEntrySchema.index({ level: -1 });

module.exports = mongoose.model('LeaderboardEntry', leaderboardEntrySchema);
