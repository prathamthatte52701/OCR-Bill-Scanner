// Runs as a child process - OCR isolated from main server
// Output: single JSON line to stdout
// Consignor-Consignee delivery challan: 4x upscale, auto-split into
// Part 1 (Consignee/Consignor header table) and Part 2 (line-items + tax table)

// argv[3], if present, is 'part1' or 'part2' - "single-part mode": the caller
// has already manually cropped this image to just that section, so the whole
// image IS the crop - no split/findSplitY logic runs at all. Without argv[3],
// behavior is 100% unchanged from before (auto-split a combined image).
const [,, imagePath, singlePartMode] = process.argv

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

    // Single-part mode: skip split-anchor detection entirely (nothing to split).
    // ocrPart and improvePart2Result are function declarations defined further
    // down in this same block - hoisted, so they're callable here already.
    if (singlePartMode === 'part1' || singlePartMode === 'part2') {
      const fullCrop = { bin: enhancedBuffer, gray: grayBuffer }
      let ocrResult = await ocrPart(fullCrop, singlePartMode)
      if (singlePartMode === 'part2') {
        ocrResult = await improvePart2Result(ocrResult, grayBuffer)
      }
      const text = ocrResult.text && ocrResult.text.length > 10 ? ocrResult.text : null
      process.stdout.write(JSON.stringify({
        part1Text: singlePartMode === 'part1' ? text : null,
        part2Text: singlePartMode === 'part2' ? text : null,
        debug: { singlePartMode, strategy: ocrResult.strategy },
      }) + '\n')
      return
    }

    const splitY = await findSplitY(worker, grayBuffer, pageHeight)
    const padding = Math.round(pageHeight * 0.01)
    // Part 2's top edge gets extra buffer (vs Part 1's bottom edge) so a slightly
    // late split anchor can't clip the first item row out of the crop entirely.
    const part2TopPadding = Math.round(pageHeight * 0.025)

    async function cropBoth(top, height) {
      const bin = await sharp(enhancedBuffer).extract({ left: 0, top, width: pageWidth, height }).toBuffer()
      const gray = await sharp(grayBuffer).extract({ left: 0, top, width: pageWidth, height }).toBuffer()
      return { bin, gray }
    }

    const part1Crops = await cropBoth(0, Math.max(1, splitY + padding))
    const part2Top = Math.max(0, splitY - part2TopPadding)
    const part2Crops = await cropBoth(part2Top, pageHeight - part2Top)

    // A bare 6-digit run is NOT enough evidence - this template's footer
    // boilerplate always has one too (phone numbers like "07292 402611", CIN
    // fragments), and "UNCODED RGP"/"HSN" etc. are printed as column headers
    // even when the row data below them got lost, so keyword-anywhere-in-text
    // + digit-anywhere-in-text (unrelated, non-adjacent matches) still
    // false-positives. Every real item row on this template carries the HSN/SAC
    // code "998729" or "998719" specifically - checking for those two known
    // codes verbatim is unambiguous proof an actual row was captured. Used ONLY
    // by the Part-2-only last-resort table-band recovery further below - normal
    // candidate selection (both Part 1 and Part 2) is untouched plain
    // scoreResult(), exactly as it was before this recovery mechanism existed.
    function hasTableEvidence(text) {
      return /\b998(729|719)\b/.test(text)
    }

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
      // confidence is additive info only - existing callers destructure just
      // .text/.strategy today and are unaffected by this extra field being present.
      return { text: cleanOCRText(winner.result.text), strategy: winner.label, confidence: winner.result.confidence }
    }

    // Part 2 ONLY, and only ever called AFTER the Part 1/Part 2 split decision
    // below has already fully resolved - this never participates in choosing
    // splitY, never participates in the looksLikeTable fallback-recrop decision,
    // and never touches Part 1's crop or candidates in any way. It just tries a
    // few extra preprocessing variants on whichever Part 2 crop was already
    // finalized, purely to see if any of them reads the line-items table better.
    // The line-items crop has finer print packed into 6-7 columns plus
    // handwritten annotations overlapping printed text, unlike the header crop -
    // characteristics never covered by the earlier whole-page 2x/3x/4x
    // confidence testing. Selection is still the same scoreResult() max-pick as
    // everywhere else, so this can only match or improve on the existing part2Ocr
    // result, never replace it with something worse.
    async function improvePart2Result(currentPart2Ocr, gray) {
      // currentPart2Ocr.text is already cleanOCRText'd and its real measured
      // confidence was carried through from ocrPart - reuse both as-is so this
      // candidate competes on equal footing with the new ones below.
      const candidates = [{ result: { text: currentPart2Ocr.text, confidence: currentPart2Ocr.confidence || 0 }, label: currentPart2Ocr.strategy }]

      try {
        const sharpened = await sharp(gray).sharpen({ sigma: 1.5 }).toBuffer()
        const rs = await recognize(worker, sharpened, 6)
        candidates.push({ result: { text: cleanOCRText(rs.text?.trim() || ''), confidence: rs.confidence || 0 }, label: 'part2-sharpened-psm6' })
      } catch { /* sharp/recognize failure on this candidate - skip it, never fatal */ }

      try {
        const contrastBin = await sharp(gray).linear(1.4, -30).threshold(150).toBuffer()
        const rc = await recognize(worker, contrastBin, 6)
        candidates.push({ result: { text: cleanOCRText(rc.text?.trim() || ''), confidence: rc.confidence || 0 }, label: 'part2-contrast-psm6' })
      } catch { /* same - skip on failure */ }

      try {
        const rPsm4 = await recognize(worker, gray, 4)
        candidates.push({ result: { text: cleanOCRText(rPsm4.text?.trim() || ''), confidence: rPsm4.confidence || 0 }, label: 'part2-gray-psm4' })
      } catch { /* same - skip on failure */ }

      const winner = candidates.reduce((a, b) => scoreResult(b.result) > scoreResult(a.result) ? b : a)
      const best = winner.label === currentPart2Ocr.strategy
        ? currentPart2Ocr
        : { text: winner.result.text, strategy: winner.label, confidence: winner.result.confidence }

      // The item table normally sits in the upper half of the Part 2 crop, with
      // the totals footer, declaration text, stamps, and signatures below it.
      // Tesseract's PSM 6 (uniform block) layout analysis can get confused by
      // that mixed table+free-text+stamp layout and skip the table lines
      // entirely even though they're clearly legible on their own - cropping
      // down to just the upper table band and re-running OCR on that alone
      // routinely recovers rows the full-crop pass completely missed. This is
      // MERGED (prepended) onto the winning text above, never a replacement -
      // replacing outright would drop the totals footer the winner already has
      // if the table-band crop happens to score/read "better" on its own.
      if (!hasTableEvidence(best.text)) {
        try {
          const cropMeta = await sharp(gray).metadata()
          const bandCandidates = []
          // Tried a wider band (0.55) first and it still lost the table on real
          // test data - the totals/declaration/stamp block that far down was
          // still enough to confuse layout analysis. 0.25-0.40 consistently
          // isolates just the table on real samples; try a couple of ratios
          // and keep whichever actually shows table evidence.
          for (const ratio of [0.35, 0.45]) {
            const h = Math.round((cropMeta.height || 0) * ratio)
            if (h <= 0) continue
            const band = await sharp(gray).extract({ left: 0, top: 0, width: cropMeta.width, height: h }).toBuffer()
            const rt = await recognize(worker, band, 6)
            bandCandidates.push({ result: { text: cleanOCRText(rt.text?.trim() || ''), confidence: rt.confidence || 0 }, label: `part2-tableband-${ratio}` })
          }
          const bandWithEvidence = bandCandidates.filter(c => hasTableEvidence(c.result.text))
          const bandWinner = bandWithEvidence.length
            ? bandWithEvidence.reduce((a, b) => scoreResult(b.result) > scoreResult(a.result) ? b : a)
            : null
          if (bandWinner) {
            return {
              text: `${bandWinner.result.text}\n${best.text}`,
              strategy: `${best.strategy}+${bandWinner.label}`,
              confidence: best.confidence,
            }
          }
        } catch { /* table-band recovery failed - fall through to `best` unchanged */ }
      }

      return best
    }

    // Verify part2 actually contains ITEM ROWS, not just the totals footer - if not,
    // re-split using fallback ratio. A loose keyword check (e.g. "Amount"/"Total")
    // is NOT enough: "Total Basic Amount" / "IGST ... Amount" lines alone would
    // satisfy it even when every item row was missed, silently hiding the failure.
    // Every real item row carries a 6-digit HSN/SAC code (e.g. 998729) - require
    // that as concrete evidence at least one row was actually captured.
    let part1Ocr = await ocrPart(part1Crops, 'part1')
    let part2Ocr = await ocrPart(part2Crops, 'part2')
    let part2GrayUsed = part2Crops.gray

    const looksLikeTable = /\b\d{6}\b/.test(part2Ocr.text) && /SR\s*NO|DESCRIPTION|HSN|QUANTITY/i.test(part2Ocr.text)
    if (!looksLikeTable) {
      const fallbackY = Math.round(pageHeight * 0.46)
      const fallbackPart2Crops = await cropBoth(fallbackY, pageHeight - fallbackY)
      const retryOcr = await ocrPart(fallbackPart2Crops, 'part2-fallback')
      if (/SR\s*NO|DESCRIPTION|HSN|AMOUNT|QUANTITY/i.test(retryOcr.text)) {
        part2Ocr = retryOcr
        part2GrayUsed = fallbackPart2Crops.gray
        const fallbackPart1Crops = await cropBoth(0, fallbackY)
        part1Ocr = await ocrPart(fallbackPart1Crops, 'part1-fallback')
      }
    }

    // Part 1's crop and the split/fallback decision above are fully settled by
    // this point and are never revisited - this call can only change part2Ocr.
    part2Ocr = await improvePart2Result(part2Ocr, part2GrayUsed)

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
