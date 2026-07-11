// Runs as a child process - PDF rasterization isolated from the main server,
// same isolation pattern as ocr-worker.js. A malformed/hostile scanned PDF can
// crash or hang this rendering step (pdfjs-dist + native canvas); running it
// out-of-process means that failure can never take down the main Express server.
// argv: [pdfPath, outputPngPath]
// Output: single JSON line to stdout - { success: true, numPages } or { success: false, error }

const [,, pdfPath, outputPngPath] = process.argv

async function run() {
  const fs = require('fs')
  const path = require('path')
  const { pathToFileURL } = require('url')

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = require('@napi-rs/canvas')

  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  ).href
  const standardFontDataUrl = pathToFileURL(
    path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep
  ).href

  const buffer = fs.readFileSync(pdfPath)
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl }).promise
  const numPages = doc.numPages

  const page = await doc.getPage(1)
  // Render at a moderate native scale - the shared image pipeline applies its
  // own 4x upscale next, so rendering too high here just wastes memory/time
  // without improving OCR confidence (verified empirically on phone-photo
  // samples: confidence plateaus well before very high scale factors).
  const viewport = page.getViewport({ scale: 2.5 })
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport }).promise

  fs.writeFileSync(outputPngPath, canvas.toBuffer('image/png'))
  process.stdout.write(JSON.stringify({ success: true, numPages }) + '\n')
}

run().catch(e => {
  process.stdout.write(JSON.stringify({ success: false, error: e.message }) + '\n')
  process.exit(1)
})
