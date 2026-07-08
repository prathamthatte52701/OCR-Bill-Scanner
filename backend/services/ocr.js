// OCR Service
// Runs Tesseract in an isolated child process - server survives any crash
// Auto-splits each page into Part 1 (Consignee/Consignor header) and
// Part 2 (line-items + tax table), OCRs both independently.

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

async function extractParts(buffer, mimeType) {
  try {
    if (mimeType === 'application/pdf') return await extractFromPDF(buffer)
    return await extractFromImage(buffer, mimeType)
  } catch (err) {
    console.error('OCR error:', err.message)
    return null
  }
}

// -- Run OCR in isolated child process ----------------------------------------

async function extractFromImage(buffer, mimeType = 'image/jpeg') {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  const tmpPath = path.join(os.tmpdir(), `consignor_${Date.now()}.${ext}`)
  fs.writeFileSync(tmpPath, buffer)
  try {
    const result = await runOCRWorker(tmpPath)
    console.log(`OCR result: part1=${result?.part1Text?.length || 0} chars, part2=${result?.part2Text?.length || 0} chars`)
    return result
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

function runOCRWorker(imagePath) {
  return new Promise((resolve) => {
    const workerPath = path.join(__dirname, 'ocr-worker.js')
    const child = spawn(process.execPath, [workerPath, imagePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })

    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean)
      const lastLine = lines[lines.length - 1]
      try {
        const parsed = JSON.parse(lastLine)
        if (parsed.debug) console.log(`OCR split debug: splitY=${parsed.debug.splitY}, part1=${parsed.debug.part1Strategy}, part2=${parsed.debug.part2Strategy}`)
        if (parsed.part1Text || parsed.part2Text) {
          resolve({ part1Text: parsed.part1Text || null, part2Text: parsed.part2Text || null })
        } else {
          console.warn('OCR worker returned no text. Error:', parsed.error || 'unknown')
          resolve(null)
        }
      } catch {
        console.warn('OCR worker output parse failed. Exit code:', code)
        console.warn('stdout:', stdout.slice(0, 200))
        resolve(null)
      }
    })

    child.on('error', (err) => {
      console.error('OCR worker spawn error:', err.message)
      resolve(null)
    })
  })
}

// -- PDF extraction ------------------------------------------------------------
// Note: only digital PDFs with a text layer are supported; scanned PDFs should
// be uploaded as JPG/PNG so the image split+OCR pipeline can run.

async function extractFromPDF(buffer) {
  try {
    const pdfParse = require('pdf-parse')
    const data = await pdfParse(buffer, { max: 4 })
    const text = data.text?.trim()
    if (text && text.length > 80) {
      console.log(`PDF text layer: ${text.length} chars, ${data.numpages} pages`)
      const cleaned = cleanOCRText(text)
      return { part1Text: cleaned, part2Text: cleaned }
    }
  } catch (err) {
    console.error('pdf-parse error:', err.message)
  }
  console.warn('PDF has no readable text layer. Upload scanned PDFs as JPG or PNG.')
  return null
}

// -- OCR text cleanup ----------------------------------------------------------

function cleanOCRText(text) {
  if (!text) return text
  return text
    .replace(/\f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{4,}/g, '   ')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/\bG\s+S\s+T\b/gi, 'GST')
    .replace(/\bP\s+A\s+N\b/gi, 'PAN')
    .replace(/\bI\s+N\s+R\b/gi, 'INR')
    .replace(/Rs\.\s{2,}/gi, 'Rs. ')
    .trim()
}

module.exports = { extractParts }
