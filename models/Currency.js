// models/Currency.js
const mongoose = require('mongoose');
const redis = require('../utils/redis');

const currencySchema = new mongoose.Schema({
  userId: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  transactions: [{
    id: { type: String, default: () => uuidv4() },
    amount: Number,
    type: { type: String, enum: ['earn', 'spend', 'reward', 'purchase'] },
    source: String,
    metadata: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now }
  }],
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Кэширование в Redis при обновлении
currencySchema.post('save', async function(doc) {
  await redis.set(`currency:${doc.userId}`, JSON.stringify({
    balance: doc.balance,
    updatedAt: doc.updatedAt
  }), 'EX', 3600); // Кэш на 1 час
});

const Currency = mongoose.model('Currency', currencySchema);

module.exports = Currency;
