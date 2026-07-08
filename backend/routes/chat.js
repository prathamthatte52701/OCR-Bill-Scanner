const express = require('express')
const router = express.Router({ mergeParams: true })
const Document = require('../models/Document')
const ChatMessage = require('../models/ChatMessage')
const ChatFeedback = require('../models/ChatFeedback')
const { answerQuestion } = require('../services/groq')

const CHAT_LIMIT = 50

// GET /api/documents/:id/chat
router.get('/', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).select('_id')
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const messages = await ChatMessage.find({ documentId: req.params.id })
      .sort({ createdAt: 1 })
      .limit(CHAT_LIMIT)
    res.json({ messages })
  } catch {
    res.status(500).json({ error: 'Failed to load chat history.' })
  }
})

// POST /api/documents/:id/chat
router.post('/', async (req, res) => {
  try {
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' })

    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    if (doc.uploadStatus !== 'processed') {
      return res.status(400).json({ error: 'Document has not been processed yet.' })
    }

    // Save user message
    await ChatMessage.create({
      documentId: doc._id,
      role: 'user',
      message: message.trim(),
    })

    const ocrText = [doc.part1OcrTextHidden, doc.part2OcrTextHidden].filter(Boolean).join('\n\n')

    // Generate answer
    let answer
    try {
      answer = await answerQuestion(message.trim(), {
        fields: doc.extractedFields,
        tables: doc.extractedTables,
        summaryPoints: doc.summaryPoints,
        ocrText,
      })
    } catch (err) {
      answer = 'AI analysis is unavailable. Please check the Groq API key or try again later.'
    }

    const assistantMsg = await ChatMessage.create({
      documentId: doc._id,
      role: 'assistant',
      message: answer,
    })

    const count = await ChatMessage.countDocuments({ documentId: doc._id })
    const excess = count - CHAT_LIMIT
    if (excess > 0) {
      const oldest = await ChatMessage.find({ documentId: doc._id }).sort({ createdAt: 1 }).limit(excess).select('_id')
      await ChatMessage.deleteMany({ _id: { $in: oldest.map(m => m._id) } })
    }

    res.json({ message: assistantMsg })
  } catch (err) {
    console.error('Chat error:', err)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// POST /api/documents/:id/chat/:messageId/feedback
router.post('/:messageId/feedback', async (req, res) => {
  try {
    const r = Number(req.body.rating)
    if (!r || r < 1 || r > 10) return res.status(400).json({ error: 'Rating must be 1-10.' })
    await ChatFeedback.findOneAndUpdate(
      { documentId: req.params.id, messageId: req.params.messageId },
      { $set: { rating: r } },
      { upsert: true }
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Feedback error:', err.message)
    res.status(500).json({ error: 'Failed to save feedback.' })
  }
})

module.exports = router
