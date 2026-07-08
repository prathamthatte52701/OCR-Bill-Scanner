const mongoose = require('mongoose')

const correctionSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
  fieldLabel: { type: String, required: true },
  fieldKey: { type: String, required: true },
  oldValue: String,
  newValue: { type: String, required: true },
  correctedAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('Correction', correctionSchema)
