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
// Digital PDFs (real text layer) go through pdf-parse as before. Scanned PDFs
// (a photographed/printed page with no text layer - just an embedded image)
// have no text layer to extract, so page 1 is rasterized to a PNG (in its own
// isolated child process - see renderPdfPageToPng) and run through the exact
// same image pipeline (4x upscale, Part1/Part2 split, Tesseract) used for
// JPG/PNG uploads - no separate OCR logic is duplicated.

async function extractFromPDF(buffer) {
  try {
    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      const text = (result.pages || []).map(p => p.text).join('\n').trim()
      if (text && text.length > 80) {
        console.log(`PDF text layer: ${text.length} chars, ${result.total} pages`)
        const cleaned = cleanOCRText(text)
        return { part1Text: cleaned, part2Text: cleaned }
      }
    } finally {
      await parser.destroy()
    }
  } catch (err) {
    console.error('pdf-parse error:', err.message)
  }

  console.log('PDF has no readable text layer - treating as a scanned PDF, rasterizing page 1 for OCR.')
  try {
    const { pngBuffer, numPages } = await renderPdfPageToPng(buffer)
    const result = await extractFromImage(pngBuffer, 'image/png')
    if (!result) return null

    // Only page 1 of a scanned PDF is ever rasterized/OCR'd - this app's document
    // model assumes one bill per upload (every real sample is "Page 1 of 1"), so
    // this is a deliberate scope limit, not a bug. Surface it when it matters so
    // it's never a silent data-loss surprise on a genuinely multi-page file.
    if (numPages > 1) {
      const warning = `This PDF has ${numPages} pages - only page 1 was read. Upload additional pages separately if needed.`
      console.warn(warning)
      return { ...result, ocrWarnings: [warning] }
    }
    return result
  } catch (err) {
    console.error('Scanned PDF rasterization failed:', err.message)
    return null
  }
}

// Rasterizes page 1 of a PDF to a PNG in an isolated child process (mirrors
// runOCRWorker's pattern) - pdfjs-dist + native canvas rendering on a malformed
// or hostile scanned PDF must never be able to crash or hang the main server.
function renderPdfPageToPng(buffer) {
  return new Promise((resolve, reject) => {
    const tmpPdfPath = path.join(os.tmpdir(), `consignor_pdf_${Date.now()}.pdf`)
    const tmpPngPath = path.join(os.tmpdir(), `consignor_pdf_${Date.now()}.png`)
    fs.writeFileSync(tmpPdfPath, buffer)

    const cleanup = () => {
      try { fs.unlinkSync(tmpPdfPath) } catch {}
      try { fs.unlinkSync(tmpPngPath) } catch {}
    }

    const workerPath = path.join(__dirname, 'pdf-render-worker.js')
    const child = spawn(process.execPath, [workerPath, tmpPdfPath, tmpPngPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    })

    let stdout = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', () => {})

    child.on('close', () => {
      try {
        const lines = stdout.trim().split('\n').filter(Boolean)
        const parsed = JSON.parse(lines[lines.length - 1])
        if (parsed.success) {
          const pngBuffer = fs.readFileSync(tmpPngPath)
          cleanup()
          resolve({ pngBuffer, numPages: parsed.numPages || 1 })
        } else {
          cleanup()
          reject(new Error(parsed.error || 'PDF rendering failed'))
        }
      } catch (err) {
        cleanup()
        reject(new Error('PDF render worker output could not be parsed: ' + err.message))
      }
    })

    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
  })
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
