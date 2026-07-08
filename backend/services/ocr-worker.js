// Runs as a child process - OCR isolated from main server
// Output: single JSON line to stdout
// Consignor-Consignee delivery challan: 4x upscale, auto-split into
// Part 1 (Consignee/Consignor header table) and Part 2 (line-items + tax table)

const [,, imagePath] = process.argv

async function run() {
  const fs = require('fs')
  const buffer = fs.readFileSync(imagePath)

  const sharp = require('sharp')
  const Tesseract = require('tesseract.js')

  // -- Step 1: 4x upscale for maximum OCR readability (accuracy over speed) --
  const meta = await sharp(buffer).metadata()
  const upscaledBuffer = await sharp(buffer)
    .resize({ width: (meta.width || 1000) * 4, kernel: 'lanczos3', withoutEnlargement: false })
    .toBuffer()

  // -- Step 2: grayscale only. Testing against these phone-photo samples showed
  // normalise()/sharpen()/threshold() all REDUCE Tesseract confidence vs plain
  // upscale+grayscale (55-58 vs 26-30) - aggressive contrast stretching and hard
  // thresholding destroy thin printed strokes on this print quality. Keep the
  // gray buffer as the primary OCR input; a binarized variant is still tried as
  // a fallback candidate per-part in case a specific crop benefits from it.
  const grayBuffer = await sharp(upscaledBuffer)
    .grayscale()
    .toBuffer()

  const enhancedBuffer = await sharp(grayBuffer)
    .threshold(160)
    .toBuffer()

  const enhancedMeta = await sharp(enhancedBuffer).metadata()

  async function prepBinarize(buf) {
    try {
      return await sharp(buf).threshold(140).toBuffer()
    } catch { return buf }
  }

  async function recognize(worker, imgBuf, psm, withWords = false) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' })
    // tesseract.js v7 only populates data.blocks (and therefore word-level bboxes)
    // when explicitly requested via the third options argument - without it,
    // data.blocks is null and data.words does not exist at all.
    const { data } = withWords
      ? await worker.recognize(imgBuf, {}, { blocks: true })
      : await worker.recognize(imgBuf)
    if (withWords) {
      const words = []
      ;(data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => (l.words || []).forEach(w => words.push(w)))))
      data.words = words
    }
    return data
  }

  function scoreResult(result) {
    const { text, confidence } = result
    if (!text || text.length < 20) return 0
    const alphaNum = (text.match(/[a-zA-Z0-9]/g) || []).length
    const total = text.replace(/\s/g, '').length || 1
    const ratio = alphaNum / total
    if (ratio < 0.3) return 0
    return confidence * Math.min(text.length, 800) * ratio
  }

  function cleanOCRText(text) {
    if (!text) return text
    return text
      .replace(/\f/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .replace(/[ \t]{4,}/g, '   ').replace(/\n{4,}/g, '\n\n\n')
      .replace(/\bG\s+S\s+T\b/gi, 'GST').replace(/\bP\s+A\s+N\b/gi, 'PAN')
      .replace(/\bI\s+N\s+R\b/gi, 'INR').replace(/Rs\.\s{2,}/gi, 'Rs. ').trim()
  }

  // -- Step 3: locate the split boundary between header table and line-items table --
  // The fixed template has a full-width "UNCODED RGP" divider row directly above the
  // "SR No. | Description | HSN/SAC | Basic | Quantity | Amount" table header.
  // Anchor the split on that row's text position rather than a fixed pixel ratio,
  // so the split still works if a page is scanned slightly differently sized.
  async function findSplitY(worker, imgBuf, pageHeight) {
    try {
      const data = await recognize(worker, imgBuf, 6, true)
      const words = data.words || []

      const findWordY = (predicate) => {
        const match = words.find(w => predicate((w.text || '').toUpperCase()))
        return match ? match.bbox.y0 : null
      }

      // Primary anchor: "UNCODED" (from "UNCODED RGP" divider row) - OCR often mangles
      // this word on low-res phone photos ("UNC/ODED", "UNCJODED" etc), so match loosely.
      let y = findWordY(t => t.includes('UNC') || t.includes('CODED') || t.includes('RGP'))
      // Secondary anchor: the "SR" of "SR No." table header (appears right after divider)
      if (y === null) {
        const srWord = words.find(w => /^SR$/i.test((w.text || '').trim()))
        if (srWord) y = srWord.bbox.y0 - Math.round(pageHeight * 0.02)
      }
      // Tertiary anchor: "Description" column header
      if (y === null) {
        y = findWordY(t => t.includes('DESCRIPTION'))
      }

      if (y !== null && y > pageHeight * 0.15 && y < pageHeight * 0.75) {
        return y
      }
    } catch { /* fall through to default ratio */ }
    // Fallback: fixed template consistently puts the divider row around 46% down the page
    return Math.round(pageHeight * 0.46)
  }

  const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} })

  try {
    const pageHeight = enhancedMeta.height || 2000
    const pageWidth = enhancedMeta.width || 1500

    const splitY = await findSplitY(worker, grayBuffer, pageHeight)
    const padding = Math.round(pageHeight * 0.01)

    async function cropBoth(top, height) {
      const bin = await sharp(enhancedBuffer).extract({ left: 0, top, width: pageWidth, height }).toBuffer()
      const gray = await sharp(grayBuffer).extract({ left: 0, top, width: pageWidth, height }).toBuffer()
      return { bin, gray }
    }

    const part1Crops = await cropBoth(0, Math.max(1, splitY + padding))
    const part2Top = Math.max(0, splitY - padding)
    const part2Crops = await cropBoth(part2Top, pageHeight - part2Top)

    async function ocrPart({ bin, gray }, label) {
      const candidates = []

      const r1 = await recognize(worker, bin, 6)
      candidates.push({ result: { text: r1.text?.trim() || '', confidence: r1.confidence || 0 }, label: `${label}-bin-psm6` })

      const r2 = await recognize(worker, gray, 6)
      candidates.push({ result: { text: r2.text?.trim() || '', confidence: r2.confidence || 0 }, label: `${label}-gray-psm6` })

      if (Math.max(scoreResult(candidates[0].result), scoreResult(candidates[1].result)) < 15000) {
        const r3 = await recognize(worker, bin, 4)
        candidates.push({ result: { text: r3.text?.trim() || '', confidence: r3.confidence || 0 }, label: `${label}-bin-psm4` })

        const softBin = await prepBinarize(gray)
        const r4 = await recognize(worker, softBin, 6)
        candidates.push({ result: { text: r4.text?.trim() || '', confidence: r4.confidence || 0 }, label: `${label}-softbin-psm6` })
      }

      const winner = candidates.reduce((a, b) => scoreResult(a.result) > scoreResult(b.result) ? a : b)
      return { text: cleanOCRText(winner.result.text), strategy: winner.label }
    }

    // Verify part2 actually contains table content - if not, re-split using fallback ratio
    let part1Ocr = await ocrPart(part1Crops, 'part1')
    let part2Ocr = await ocrPart(part2Crops, 'part2')

    const looksLikeTable = /SR\s*NO|DESCRIPTION|HSN|AMOUNT|QUANTITY/i.test(part2Ocr.text)
    if (!looksLikeTable) {
      const fallbackY = Math.round(pageHeight * 0.46)
      const fallbackPart2Crops = await cropBoth(fallbackY, pageHeight - fallbackY)
      const retryOcr = await ocrPart(fallbackPart2Crops, 'part2-fallback')
      if (/SR\s*NO|DESCRIPTION|HSN|AMOUNT|QUANTITY/i.test(retryOcr.text)) {
        part2Ocr = retryOcr
        const fallbackPart1Crops = await cropBoth(0, fallbackY)
        part1Ocr = await ocrPart(fallbackPart1Crops, 'part1-fallback')
      }
    }

    process.stdout.write(JSON.stringify({
      part1Text: part1Ocr.text && part1Ocr.text.length > 10 ? part1Ocr.text : null,
      part2Text: part2Ocr.text && part2Ocr.text.length > 10 ? part2Ocr.text : null,
      debug: { splitY, part1Strategy: part1Ocr.strategy, part2Strategy: part2Ocr.strategy },
    }) + '\n')
  } finally {
    try { await worker.terminate() } catch {}
  }
}

run().catch(e => {
  process.stdout.write(JSON.stringify({ error: e.message, part1Text: null, part2Text: null }) + '\n')
  process.exit(1)
})
