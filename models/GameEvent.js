const mongoose = require('mongoose');

const gameEventSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  type: { type: String, enum: ['click', 'collection', 'battle'], required: true },
  rewards: [{
    name: { type: String },
    type: { type: String, enum: ['orcas', 'premium', 'skin'] },
    value: { type: Number }
  }],
  participants: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
    progress: { type: Number, default: 0 },
    rewardsClaimed: { type: Boolean, default: false }
  }],
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('GameEvent', gameEventSchema);
