const mongoose = require('mongoose')

const fieldSchema = new mongoose.Schema({
  label: String,
  normalizedKey: String,
  value: String,
  edited: { type: Boolean, default: false },
  category: String,
  confidence: { type: String, enum: ['high', 'medium', 'low'] },
  sourceLine: String,
}, { _id: false })

const tableSchema = new mongoose.Schema({
  title: String,
  confidence: { type: String, enum: ['high', 'medium', 'low'] },
  columns: [String],
  rows: [mongoose.Schema.Types.Mixed],
  sourceHint: String,
}, { _id: false })

const lineItemSchema = new mongoose.Schema({
  srNo: String,
  description: String,
  hsnSac: String,
  basic: String,
  quantity: String,
  amount: String,
}, { _id: false })

const partySchema = new mongoose.Schema({
  code: String,
  name: String,
  address: String,
  stateCode: String,
  stateName: String,
  gstin: String,
  pan: String,
}, { _id: false })

const totalsSchema = new mongoose.Schema({
  totalBasicAmount: String,
  cgst: String,
  sgst: String,
  igst: String,
  totalAmount: String,
}, { _id: false })

const documentSchema = new mongoose.Schema({
  autoName: { type: String, required: true },
  originalFilename: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  gridFsFileId: { type: mongoose.Schema.Types.ObjectId },
  // Two-image upload flow: user manually crops and uploads Part 1 (header) and
  // Part 2 (line-items) separately, instead of one combined-page image. When
  // set, gridFsFileId above is unused for this document; download endpoints
  // use these two instead. Null for documents uploaded the older, single-image
  // way (auto-split), which remains fully supported.
  part1FileId: { type: mongoose.Schema.Types.ObjectId, default: null },
  part1OriginalFilename: { type: String, default: null },
  part2FileId: { type: mongoose.Schema.Types.ObjectId, default: null },
  part2OriginalFilename: { type: String, default: null },
  uploadStatus: {
    type: String,
    enum: ['uploaded', 'processed', 'failed'],
    default: 'uploaded',
  },
  documentType: String,
  part1OcrTextHidden: String,
  part2OcrTextHidden: String,
  extractedFields: [fieldSchema],
  extractedTables: [tableSchema],
  summaryPoints: [String],
  fullSummary: String,
  warnings: [String],
  processingError: String,
  processedAt: Date,
  reprocessedAt: Date,
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
  // Training system - weight increases each time a field is corrected by user
  trainingWeight: { type: Number, default: 1 },
  // normalizedKeys of every field ever manually corrected - persists across view
  // regeneration so the "(edited)" indicator survives even though fields/tables
  // are rebuilt from scratch on every correction.
  editedFieldKeys: { type: [String], default: [] },

  // Consignor-Consignee delivery challan fields
  invoiceNo: { type: String, default: null },
  fiDoc: { type: String, default: null },
  challanDate: { type: String, default: null },
  reason: { type: String, default: null },
  poNo: { type: String, default: null },
  requestNo: { type: String, default: null },
  irnNo: { type: String, default: null },
  vecvGstin: { type: String, default: null },
  vecvPan: { type: String, default: null },
  consignee: { type: partySchema, default: null },
  consignor: { type: partySchema, default: null },
  lineItems: [lineItemSchema],
  totals: { type: totalsSchema, default: null },

  // Part-level breakdown - user should see Part 1 (header) and Part 2 (line items) separately
  part1: {
    ocrText: String,
    fields: [fieldSchema],
    summary: String,
  },
  part2: {
    ocrText: String,
    fields: [fieldSchema],
    tables: [tableSchema],
    summary: String,
  },

  extractionWarnings: [{ type: String }],
}, {
  timestamps: true,
})

module.exports = mongoose.model('Document', documentSchema)
