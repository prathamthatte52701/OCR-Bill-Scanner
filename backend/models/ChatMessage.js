const mongoose = require('mongoose')

const chatMessageSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  message: { type: String, required: true },
  answerType: String,
}, {
  timestamps: true,
})

module.exports = mongoose.model('ChatMessage', chatMessageSchema)
