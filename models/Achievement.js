const mongoose = require('mongoose');

const achievementSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  reward: { type: Number, default: 0 },
  unlocked: { type: Boolean, default: false },
  userId: { type: mongoose.Schema.Types.Mixed, ref: 'Player' },
  unlockedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Achievement', achievementSchema);
