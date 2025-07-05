const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  role: { type: String, enum: ['member', 'officer', 'leader'], default: 'member' },
  contribution: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now }
});

const clanSchema = new mongoose.Schema({
  name: { type: String, required: true },
  tag: { type: String, required: true, unique: true, maxlength: 4 },
  description: { type: String },
  level: { type: Number, default: 1 },
  exp: { type: Number, default: 0 },
  members: [memberSchema],
  createdAt: { type: Date, default: Date.now }
});

clanSchema.index({ tag: 1 });
clanSchema.index({ 'members.userId': 1 });

module.exports = mongoose.model('Clan', clanSchema);
