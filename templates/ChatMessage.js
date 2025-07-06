const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  username: { type: String, required: true },
  text: { type: String, required: true, maxlength: 200 },
  channel: { type: String, enum: ['global', 'clan', 'private'], default: 'global' },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' }, // Для приватных сообщений
  clanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clan' } // Для кланового чата
}, { timestamps: true });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
