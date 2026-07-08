const mongoose = require('mongoose')

const chatFeedbackSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', required: true },
  rating: { type: Number, min: 1, max: 10, required: true },
}, { timestamps: true })

chatFeedbackSchema.index({ documentId: 1, messageId: 1 }, { unique: true })

module.exports = mongoose.model('ChatFeedback', chatFeedbackSchema)
