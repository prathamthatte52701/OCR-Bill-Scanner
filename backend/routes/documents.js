const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')

// -- Processing queue - max 1 OCR job at a time to prevent OOM crashes ---------
let _processing = false
const _queue = []
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject })
    drainQueue()
  })
}
async function drainQueue() {
  if (_processing || _queue.length === 0) return
  _processing = true
  const { fn, resolve, reject } = _queue.shift()
  try { resolve(await fn()) } catch (e) { reject(e) }
  finally { _processing = false; drainQueue() }
}
const Document = require('../models/Document')
const Correction = require('../models/Correction')
const { uploadBuffer, downloadBuffer, deleteFile } = require('../services/gridfs')
const { extractParts } = require('../services/ocr')
const { analyzeDocument, assembleDocumentViews, applyCorrection } = require('../services/groq')

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
    if (!allowed.includes(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, JPEG, PNG, and PDF files are allowed.'))
    }
    cb(null, true)
  },
})

// Wrap multer to catch its errors cleanly
function uploadMiddleware(req, res, next) {
  upload.single('document')(req, res, (err) => {
    if (!err) return next()
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size must be 5 MB or less.' })
      }
      return res.status(400).json({ error: err.field || 'Only JPG, JPEG, PNG, and PDF files are allowed.' })
    }
    return res.status(400).json({ error: err.message || 'Upload failed.' })
  })
}

function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf'
  return null
}

function mimeMatchesUpload(declared, detected) {
  if (!detected) return false
  if (declared === detected) return true
  return declared === 'image/jpg' && detected === 'image/jpeg'
}

// Document display name is the actual uploaded filename, extension stripped -
// e.g. "delivery-challan-123.jpg" -> "delivery-challan-123".
function nameFromOriginalFilename(originalname) {
  return path.parse(originalname).name || originalname
}

async function getPDFPageCount(buffer) {
  try {
    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    try {
      const info = await parser.getInfo() // metadata only, no text/page extraction
      return info.total || 1
    } finally {
      await parser.destroy()
    }
  } catch (err) {
    console.error('getPDFPageCount error:', err.message)
    return null
  }
}

function updateActiveDocument(docId, update) {
  return Document.updateOne({ _id: docId, isDeleted: { $ne: true } }, update)
}

// POST /api/documents/upload
router.post('/upload', uploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' })
    }

    const { buffer, mimetype, originalname, size } = req.file
    const detectedMimeType = detectMimeType(buffer)
    if (!mimeMatchesUpload(mimetype, detectedMimeType)) {
      return res.status(400).json({ error: 'File content does not match the selected file type.' })
    }

    if (mimetype === 'application/pdf') {
      const pages = await getPDFPageCount(buffer)
      if (!pages) {
        return res.status(400).json({ error: 'Could not read this PDF. Please upload a valid PDF or convert it to JPG/PNG.' })
      }
      if (pages > 4) {
        return res.status(400).json({ error: 'PDF must be 4 pages or less.' })
      }
    }

    const autoName = nameFromOriginalFilename(originalname)
    const gridFsFileId = await uploadBuffer(buffer, originalname, mimetype)

    const doc = await Document.create({
      autoName,
      originalFilename: originalname,
      mimeType: mimetype,
      size,
      gridFsFileId,
      uploadStatus: 'uploaded',
    })

    // Queue processing - only 1 OCR job runs at a time to prevent OOM
    enqueue(() => processDocument(doc._id, buffer, mimetype)).catch(err => {
      console.error('Background processing error:', err.message)
    })

    res.status(201).json({ document: doc })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: 'Something went wrong while processing this document.' })
  }
})

async function processDocument(docId, buffer, mimeType) {
  try {
    const ocrParts = await extractParts(buffer, mimeType)
    if (!ocrParts || (!ocrParts.part1Text?.trim() && !ocrParts.part2Text?.trim())) {
      await updateActiveDocument(docId, {
        uploadStatus: 'failed',
        processingError: 'We could not read this document.',
      })
      return
    }

    let groqResult
    try {
      groqResult = await analyzeDocument(ocrParts)
    } catch (err) {
      console.error('AI extraction error:', err.message)
      await updateActiveDocument(docId, {
        uploadStatus: 'failed',
        part1OcrTextHidden: ocrParts.part1Text || null,
        part2OcrTextHidden: ocrParts.part2Text || null,
        processingError: 'AI analysis is unavailable. Please check the Groq API key or try again later.',
      })
      return
    }

    // OCR-level warnings (e.g. "this scanned PDF has N pages, only page 1 was
    // read") originate before the AI extraction step, so they aren't already
    // part of groqResult.warnings - merge them in so they actually reach the user
    // instead of only ever being logged to the server console.
    const allWarnings = [...(ocrParts.ocrWarnings || []), ...(groqResult.warnings || [])]

    await updateActiveDocument(docId, {
      uploadStatus: 'processed',
      part1OcrTextHidden: ocrParts.part1Text || null,
      part2OcrTextHidden: ocrParts.part2Text || null,
      documentType: groqResult.documentType || 'Unknown',
      fullSummary: groqResult.fullSummary || null,
      summaryPoints: groqResult.summaryPoints || [],
      extractedFields: groqResult.fields || [],
      extractedTables: groqResult.tables || [],
      // Consignor-Consignee fields
      invoiceNo: groqResult.invoiceNo || null,
      fiDoc: groqResult.fiDoc || null,
      challanDate: groqResult.challanDate || null,
      reason: groqResult.reason || null,
      poNo: groqResult.poNo || null,
      requestNo: groqResult.requestNo || null,
      irnNo: groqResult.irnNo || null,
      consignee: groqResult.consignee || null,
      consignor: groqResult.consignor || null,
      lineItems: groqResult.lineItems || [],
      totals: groqResult.totals || null,
      part1: groqResult.part1 ? { ocrText: ocrParts.part1Text || null, ...groqResult.part1 } : null,
      part2: groqResult.part2 ? { ocrText: ocrParts.part2Text || null, ...groqResult.part2 } : null,
      warnings: allWarnings,
      extractionWarnings: allWarnings,
      processingError: null,
      processedAt: new Date(),
    })
  } catch (err) {
    console.error('processDocument error:', err.message)
    await updateActiveDocument(docId, {
      uploadStatus: 'failed',
      processingError: 'Something went wrong while processing this document.',
    })
  }
}

async function recoverInterruptedUploads() {
  const docs = await Document.find({ uploadStatus: 'uploaded', isDeleted: { $ne: true } })
    .select('_id mimeType gridFsFileId')

  docs.forEach((doc) => {
    enqueue(async () => {
      try {
        const activeDoc = await Document.findOne({
          _id: doc._id,
          uploadStatus: 'uploaded',
          isDeleted: { $ne: true },
        }).select('_id mimeType gridFsFileId')

        if (!activeDoc) return

        const buffer = await downloadBuffer(activeDoc.gridFsFileId)
        await processDocument(activeDoc._id, buffer, activeDoc.mimeType)
      } catch (err) {
        console.error(`Recovery failed for document ${doc._id}:`, err.message)
        await updateActiveDocument(doc._id, {
          uploadStatus: 'failed',
          processingError: 'Processing was interrupted and could not be recovered. Please reprocess this document.',
        })
      }
    }).catch(err => console.error('Recovery queue error:', err.message))
  })

  return docs.length
}

// GET /api/documents/training-stats
router.get('/training-stats', async (req, res) => {
  try {
    const trainedCount = await Document.countDocuments({
      isDeleted: { $ne: true },
      uploadStatus: 'processed',
      $or: [
        { extractedFields: { $exists: true, $not: { $size: 0 } } },
        { invoiceNo: { $exists: true, $ne: null } },
      ],
    })
    const correctedCount = await Document.countDocuments({
      isDeleted: { $ne: true },
      trainingWeight: { $gt: 1 },
    })
    res.json({ trainedCount, correctedCount })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch training stats.' })
  }
})

// GET /api/documents/feedback-stats
router.get('/feedback-stats', async (req, res) => {
  try {
    const ChatFeedback = require('../models/ChatFeedback')
    const feedbacks = await ChatFeedback.find({}).lean()
    const total = feedbacks.length
    if (!total) return res.json({ avgRating: 0, totalFeedback: 0, top3: [] })

    const avg = feedbacks.reduce((s, f) => s + f.rating, 0) / total
    const avgRating = Math.round(avg * 10) / 10

    // Group ratings by document
    const byDoc = {}
    feedbacks.forEach(f => {
      const id = f.documentId.toString()
      if (!byDoc[id]) byDoc[id] = []
      byDoc[id].push(f.rating)
    })
    const sorted = Object.entries(byDoc)
      .map(([id, ratings]) => ({ id, avg: ratings.reduce((s, r) => s + r, 0) / ratings.length, count: ratings.length }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 3)

    const docs = await Document.find({ _id: { $in: sorted.map(s => s.id) } })
      .select('autoName documentType invoiceNo challanDate consignee consignor').lean()
    const docMap = {}
    docs.forEach(d => { docMap[d._id.toString()] = d })

    const top3 = sorted.map(s => ({
      ...(docMap[s.id] || {}),
      avgRating: Math.round(s.avg * 10) / 10,
      feedbackCount: s.count,
    }))

    res.json({ avgRating, totalFeedback: total, top3 })
  } catch (err) {
    console.error('feedback-stats error:', err.message)
    res.status(500).json({ error: 'Failed to fetch feedback stats.' })
  }
})

// GET /api/documents
router.get('/', async (req, res) => {
  try {
    const documents = await Document.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .select('-part1OcrTextHidden -part2OcrTextHidden')
    res.json({ documents })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch documents.' })
  }
})

// GET /api/documents/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .select('-part1OcrTextHidden -part2OcrTextHidden')
    if (!doc) return res.status(404).json({ error: 'Document not found.' })
    res.json({ document: doc })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch document.' })
  }
})

// GET /api/documents/:id/download
router.get('/:id/download', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const buffer = await downloadBuffer(doc.gridFsFileId)
    res.set('Content-Type', doc.mimeType)
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`)
    res.send(buffer)
  } catch (err) {
    console.error('Download error:', err)
    res.status(500).json({ error: 'Failed to download file.' })
  }
})

// POST /api/documents/:id/reprocess
router.post('/:id/reprocess', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const buffer = await downloadBuffer(doc.gridFsFileId)

    await Document.findByIdAndUpdate(doc._id, {
      uploadStatus: 'uploaded',
      processingError: null,
      extractedFields: [],
      extractedTables: [],
      warnings: [],
      invoiceNo: null,
      fiDoc: null,
      challanDate: null,
      reason: null,
      poNo: null,
      requestNo: null,
      irnNo: null,
      consignee: null,
      consignor: null,
      lineItems: [],
      totals: null,
      part1: null,
      part2: null,
      extractionWarnings: [],
      editedFieldKeys: [],
    })

    // Queue reprocessing - only 1 OCR job runs at a time to prevent OOM
    enqueue(() => processDocument(doc._id, buffer, doc.mimeType))
      .then(() => updateActiveDocument(doc._id, { reprocessedAt: new Date() }))
      .catch(err => console.error('Reprocess background error:', err.message))

    res.json({ message: 'Reprocessing started. Check document status shortly.' })
  } catch (err) {
    console.error('Reprocess error:', err)
    res.status(500).json({ error: 'Reprocessing failed.' })
  }
})

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    await Document.findByIdAndUpdate(doc._id, {
      isDeleted: true,
      deletedAt: new Date(),
    })
    if (doc.gridFsFileId) {
      try {
        await deleteFile(doc.gridFsFileId)
      } catch (err) {
        console.warn(`Failed to delete GridFS file for document ${doc._id}: ${err.message}`)
      }
    }
    res.json({ message: 'Document deleted successfully.' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete document.' })
  }
})

// PATCH /api/documents/:id/fields/:fieldKey/correct
router.patch('/:id/fields/:fieldKey/correct', async (req, res) => {
  try {
    const { fieldLabel, fieldKey, oldValue, newValue } = req.body
    if (!newValue || !newValue.trim()) {
      return res.status(400).json({ error: 'New value is required.' })
    }

    const doc = await Document.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    if (!doc) return res.status(404).json({ error: 'Document not found.' })

    const fieldIndex = doc.extractedFields.findIndex(f => f.normalizedKey === req.params.fieldKey)
    if (fieldIndex === -1) return res.status(404).json({ error: 'Field not found.' })

    const trimmedValue = newValue.trim()
    const priorLabel = doc.extractedFields[fieldIndex].label
    const priorValue = doc.extractedFields[fieldIndex].value

    // Single source of truth: write the edit into the CANONICAL structured data
    // (consignee/consignor/totals/lineItems/header scalars), then regenerate
    // every derived view (fields, tables, summaries, part1/part2) from that one
    // corrected source. There is no separate "AI value" left anywhere afterward -
    // the old value is gone, not just hidden behind a display override.
    const canonical = {
      consignee: doc.consignee ? doc.consignee.toObject() : null,
      consignor: doc.consignor ? doc.consignor.toObject() : null,
      invoiceNo: doc.invoiceNo,
      fiDoc: doc.fiDoc,
      challanDate: doc.challanDate,
      reason: doc.reason,
      poNo: doc.poNo,
      requestNo: doc.requestNo,
      irnNo: doc.irnNo,
      lineItems: (doc.lineItems || []).map(item => item.toObject()),
      totals: doc.totals ? doc.totals.toObject() : null,
    }

    const applied = applyCorrection(canonical, req.params.fieldKey, trimmedValue)
    if (!applied) {
      return res.status(400).json({ error: 'This field cannot be edited.' })
    }

    if (!doc.editedFieldKeys.includes(req.params.fieldKey)) {
      doc.editedFieldKeys.push(req.params.fieldKey)
    }

    const views = assembleDocumentViews(canonical, canonical)
    const markEdited = (fields) => {
      (fields || []).forEach(f => {
        if (doc.editedFieldKeys.includes(f.normalizedKey)) f.edited = true
      })
    }
    markEdited(views.fields)
    markEdited(views.part1.fields)
    markEdited(views.part2.fields)

    doc.consignee = canonical.consignee
    doc.consignor = canonical.consignor
    doc.invoiceNo = canonical.invoiceNo
    doc.fiDoc = canonical.fiDoc
    doc.challanDate = canonical.challanDate
    doc.reason = canonical.reason
    doc.poNo = canonical.poNo
    doc.requestNo = canonical.requestNo
    doc.irnNo = canonical.irnNo
    doc.lineItems = canonical.lineItems
    doc.totals = canonical.totals

    doc.extractedFields = views.fields
    doc.extractedTables = views.tables
    doc.fullSummary = views.fullSummary
    doc.summaryPoints = views.summaryPoints
    doc.part1 = { ocrText: doc.part1?.ocrText || null, fields: views.part1.fields, summary: views.part1.summary }
    doc.part2 = { ocrText: doc.part2?.ocrText || null, fields: views.part2.fields, tables: views.part2.tables, summary: views.part2.summary }

    await doc.save()

    await Correction.create({
      documentId: doc._id,
      fieldLabel: fieldLabel || priorLabel,
      fieldKey: req.params.fieldKey,
      oldValue: oldValue ?? priorValue,
      newValue: trimmedValue,
      correctedAt: new Date(),
    })

    // Boost training weight - corrected docs are higher-quality examples
    await Document.findByIdAndUpdate(doc._id, { $inc: { trainingWeight: 1 } })

    const updated = doc.toObject()
    delete updated.part1OcrTextHidden; delete updated.part2OcrTextHidden
    res.json({ message: 'Field corrected successfully.', document: updated })
  } catch (err) {
    console.error('Correction error:', err)
    res.status(500).json({ error: 'Failed to save correction.' })
  }
})

router.recoverInterruptedUploads = recoverInterruptedUploads

module.exports = router
