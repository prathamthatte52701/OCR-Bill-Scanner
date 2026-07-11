// AI Service - Groq (free tier, llama-3.3-70b)
// Consignor-Consignee delivery challan extraction, split into two independent
// passes: Part 1 (Consignee/Consignor header table) and Part 2 (line-items +
// tax totals table). Both ignore handwritten/stamped content by design.
const Groq = require('groq-sdk')

// Multiple keys (GROQ_API_KEYS, comma-separated) are round-robined across calls so
// no single key absorbs the full request/token-per-minute load. Falls back to a
// single GROQ_API_KEY if only one is configured.
function getKeyPool() {
  const multi = process.env.GROQ_API_KEYS
  if (multi && multi.trim()) {
    return multi.split(',').map(k => k.trim()).filter(Boolean)
  }
  const single = process.env.GROQ_API_KEY
  if (single && single.trim()) return [single.trim()]
  return []
}

let keyPool = null
let nextStartIndex = 0

// Runs a Groq request, failing over to the next key in the pool if the current
// key is rate-limited/unauthorized/erroring server-side - so one exhausted key
// doesn't take the whole pipeline down. Only fails over for capacity/auth/server
// errors; a genuine bad-request error (e.g. malformed prompt) is not retried
// with a different key since that would just fail again identically.
//
// Each call picks its own fixed starting index (advanced once, synchronously,
// before any await) and then walks every key in the pool exactly once from
// there. This keeps retries within one call from ever repeating a key, even
// when multiple calls run concurrently (e.g. Part 1 + Part 2 in parallel) and
// race over the shared round-robin counter.
async function callGroqWithFailover(makeRequest) {
  if (keyPool === null) keyPool = getKeyPool()
  if (!keyPool.length) throw new Error('GROQ_API_KEY (or GROQ_API_KEYS) is not set')

  const startIndex = nextStartIndex % keyPool.length
  nextStartIndex++

  let lastError
  for (let i = 0; i < keyPool.length; i++) {
    const keyIndex = (startIndex + i) % keyPool.length
    const client = new Groq({ apiKey: keyPool[keyIndex] })
    try {
      return await makeRequest(client)
    } catch (err) {
      lastError = err
      const status = err?.status
      const shouldFailover = status === 429 || status === 401 || status === 403 || (status >= 500 && status < 600)
      console.warn(`Groq key #${keyIndex + 1}/${keyPool.length} failed (status ${status || 'unknown'}): ${err.message}${shouldFailover && i < keyPool.length - 1 ? ' - trying next key' : ''}`)
      if (!shouldFailover) throw err
    }
  }
  throw lastError
}

const PRINTED_ONLY_RULE = `
CRITICAL - PRINTED TEXT ONLY:
- This OCR text may contain handwritten notes, rubber-stamp text, signatures, or pen marks mixed in with the machine-printed form.
- Extract ONLY values that belong to the machine-printed form fields and table.
- IGNORE anything that reads like a handwritten annotation, a stamp (e.g. "OUT-WARD UNIT", "SECURITY", "Sr. No ... Time Out ... Vh No", company rubber-stamp blocks), a signature name, or loose numbers/notes scribbled outside the form's own bordered cells.
- If a printed field's value is genuinely obscured or unreadable because a stamp/pen mark overlaps it, set that field to null and add a warning - do NOT guess or substitute the handwritten text for it.`

const PART1_SYSTEM = `You are a document extraction specialist for Indian company bills (consignor consignee bills) (Consignor-Consignee) documents issued under Rule 55 of CGST Rule.

You will receive OCR text from the UPPER section of the bill only - this section is a two-column bordered table: Consignee details on the left, Consignor details on the right, plus challan metadata (Invoice No, FI Doc, Date, Reason, PO No, GSTIN/PAN, Request No, IRN No).

Return ONLY valid JSON. No markdown. No explanation. No code fences.

EXACT JSON STRUCTURE TO RETURN:
{
  "consignee": {
    "code": "Consignee Code value",
    "name": "Consignee name",
    "address": "full consignee address including city, pincode",
    "stateCode": "State Code value",
    "stateName": "state name printed next to state code",
    "gstin": "Consignee GSTIN No",
    "pan": "Consignee PAN No"
  },
  "consignor": {
    "name": "Consignor / Name value",
    "address": "full consignor address including city, pincode",
    "stateCode": "State Code value",
    "stateName": "state name printed next to state code",
    "gstin": "VECV GSTIN No / Consignor GSTIN value",
    "pan": "VECV PAN No / Consignor PAN value"
  },
  "invoiceNo": "Invoice No value",
  "fiDoc": "FI Doc value",
  "challanDate": "Date value exactly as printed (e.g. 29/06/26)",
  "reason": "Reason field text",
  "poNo": "PO No value",
  "requestNo": "Request No value",
  "irnNo": "IRN No value or null if blank",
  "warnings": []
}

FIELD LABEL GUIDE:
- "Consignee:-" / "Consignee" = the receiving party (left column)
- "Consignor:-" / "Name" (right column) = the sending party, usually "VE Commercial Vehicles Ltd"
- "GSTIN No" under Consignee = consignee.gstin; "VECV GSTIN No" = consignor.gstin
- "PAN No" under Consignee = consignee.pan; "VECV PAN No" = consignor.pan
- Address spans multiple lines (street, city, pincode) - join into one field
- "FI Doc" is a numeric document id, separate from "Invoice No"

CONSIGNEE vs CONSIGNOR DISAMBIGUATION - CRITICAL:
- The OCR text loses the visual left/right column boundary, so lines from both parties often appear interleaved, merged, or out of order.
- Everything from the start of the text up to (and not including) the line that introduces "VE Commercial Vehicles" / the Consignor's "Name" row belongs to Consignee. Everything from that point onward belongs to Consignor, until a field label clearly says "Consignee" again.
- Never let an address fragment, state code, GSTIN, or PAN that belongs to one party end up attached to the other party just because the OCR lines were adjacent or out of order. If you cannot confidently tell which party a fragment belongs to, leave that specific sub-field null rather than attaching it to the wrong party.

ADDRESS BOUNDARY RULE - CRITICAL (prevents cross-party address mixing):
- On the printed form, "Address" is its own label on one line, and the actual street/city/pincode text appears as UNLABELED lines directly below it - this is why address lines are the easiest to misattach to the wrong party.
- The Address value for a party is ONLY the text that appears strictly between that party's own "Address" label and the NEXT recognized label for that SAME party (GSTIN No, PAN No, State Code, or the other party's Name/Consignor/Consignee marker) - whichever comes first.
- Stop collecting address lines the moment you hit any of: "State Code", "GSTIN No", "PAN No", "VECV GSTIN No", "VECV PAN No", "Name", "Invoice No", "PO No." - text after one of these belongs to a different field or the other party, never to the address you were building.
- Do NOT carry a street/building line (e.g. "87A Industrial Area...", "A. B Road Dewas") into the OTHER party's address just because it appeared near their address lines in the flattened text - each party's address lines sit only under that party's own "Address" label.

REFERENCE VALUES - this document type always has the same Consignor, and the same Consignee company (only branch address/state/GSTIN differ by location). Use these ONLY to sanity-check and correct clearly OCR-garbled values, never to overwrite a value that is already clearly and consistently read as something else in the text:
- Consignor is always: name "VE Commercial Vehicles Ltd (UNIT - EEC)", address "87A Industrial Area No 3, A. B Road Dewas, 455001", state "Madhya Pradesh", stateCode "23", gstin "23AABCE9378F3ZI", pan "AABCE9378F".
- Consignee company name is always "OERLIKON BALZERS COATING INDIA" and pan is always "AAACI3916N" regardless of branch; consignee address/state/stateCode/gstin vary by branch and must come from the OCR text, not from this reference.
- If a value you're about to output for Consignor differs from its reference value, re-check whether it actually belongs to Consignee instead (a column mix-up) before accepting it as a genuine difference.

CHARACTER CORRECTION RULES - CONSERVATIVE, NEVER FABRICATE:
GSTIN format is always: 2 digits + 5 letters + 4 digits + 1 letter + 1 digit + "Z" + 1 digit (15 characters total).
PAN format is always: 5 letters + 4 digits + 1 letter (10 characters total).
- Only correct a character when the REST of the value already clearly matches the expected length/shape and the specific character is a well-known OCR confusable in that exact position (S<->5, O<->0, I<->1, Z<->2, B<->8, G<->6, or position-13 of a GSTIN which is always "Z").
- Do NOT pad, invent, or reconstruct characters to force a garbled value into the right length or shape. If the OCR text does not contain enough recognizable characters to confidently reconstruct a valid GSTIN/PAN, return null for that field - do not guess.
- NEVER write a justification like "assuming..." or "using standard format" to explain a value - if you find yourself doing that, you are fabricating; return null instead and say so in warnings.
- Log every genuine single-character correction in warnings, e.g. "Consignee GSTIN position 13: corrected 2->Z"
${PRINTED_ONLY_RULE}

NULL RULES:
- null for every missing or unreadable field - never fabricate any value
- Use warnings[] to log every field that was unclear, partially read, or excluded due to stamp/handwriting overlap`

const PART2_SYSTEM = `You are a document extraction specialist for Indian company bills (consignor consignee bills) (Consignor-Consignee) documents issued under Rule 55 of CGST Rule.

You will receive OCR text from the LOWER section of the bill only - this section is a single bordered table titled "UNCODED RGP" listing line items (SR No, Description, HSN/SAC, Basic, Quantity, Amount), followed by a totals footer (Total Basic Amount, CGST, SGST, IGST, Total Amount).

NOTE: The page split is done automatically and its exact cut line varies slightly bill to bill. Sometimes a few header metadata lines (Invoice No, FI Doc, Date, Reason, PO No, Request No, IRN No) that normally belong to the section above end up included at the very TOP of this OCR text, above "UNCODED RGP". If you see any of them, extract them too - they are a safety-net capture, not the primary content of this section.

Return ONLY valid JSON. No markdown. No explanation. No code fences.

EXACT JSON STRUCTURE TO RETURN:
{
  "lineItems": [
    {
      "srNo": "row SR No value exactly as printed",
      "description": "full item description text",
      "hsnSac": "HSN/SAC code",
      "basic": "Basic amount for this row",
      "quantity": "Quantity for this row",
      "amount": "Amount for this row"
    }
  ],
  "totals": {
    "totalBasicAmount": "Total Basic Amount value",
    "cgst": "CGST value",
    "sgst": "SGST value",
    "igst": "IGST value",
    "totalAmount": "Total Amount value"
  },
  "invoiceNo": "Invoice No value if present at the top of this text, else null",
  "fiDoc": "FI Doc value if present at the top of this text, else null",
  "challanDate": "Date value if present at the top of this text, else null",
  "reason": "Reason value if present at the top of this text, else null",
  "poNo": "PO No value if present at the top of this text, else null",
  "requestNo": "Request No value if present at the top of this text, else null",
  "irnNo": "IRN No value if present at the top of this text, else null",
  "warnings": []
}

RULES - MANDATORY:
- Extract EVERY line item row. Do not skip, merge, or summarize rows - each printed row in the table must become one entry in lineItems.
- Preserve the SR No exactly as printed even if numbering does not start at 1 - do not renumber rows.
- Amount/Basic fields contain only digits, commas, and decimal point.
- CGST/SGST/IGST rows may show "0.00" as a genuine printed value - keep it as "0.00", do not convert to null.
- NEVER invent a line item to fill a gap. A genuine row needs a real, readable Description - if you cannot read a plausible item description for a row (e.g. all you have is a stray number, a fragment like "2 S---", or noise), DO NOT add it to lineItems at all. An incomplete-but-real row (missing only Basic/Quantity) is fine to include with those fields null; a row you cannot actually read is not - omit it entirely.
- NEVER pull a value from the CGST/SGST/IGST/Total Basic Amount/Total Amount footer into a line item's Basic/Amount field. Footer totals and per-row amounts are different numbers from different parts of the text - do not cross-assign between them.
${PRINTED_ONLY_RULE}

NULL RULES:
- null for any missing or unreadable field - never fabricate any value
- If the line-items table is completely unreadable, return an empty lineItems array and explain in warnings
- Use warnings[] to log every field that was unclear, partially read, or excluded due to stamp/handwriting overlap`

function stripMarkdown(text) {
  return text
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim()
}

function sanitizeJSON(text) {
  // Remove control characters inside JSON strings that break JSON.parse
  return text.replace(
    /"((?:[^"\\]|\\.)*)"/g,
    (match) => match.replace(/[\x00-\x1F\x7F]/g, (c) => {
      const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
      return escapes[c] || ''
    })
  )
}

function parseJSON(raw) {
  const cleaned = sanitizeJSON(stripMarkdown(raw))
  try {
    return JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('AI returned invalid JSON')
    try {
      return JSON.parse(match[0])
    } catch {
      return JSON.parse(sanitizeJSON(match[0]))
    }
  }
}

async function runExtraction(systemPrompt, ocrText, label) {
  const response = await callGroqWithFailover(client => client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Extract all information from this ${label} OCR text:\n\n${ocrText}` },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  }))
  return parseJSON(response.choices[0].message.content)
}

function normalizeKey(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function addField(fields, label, value, category = 'other') {
  if (value === undefined || value === null || value === '') return
  fields.push({
    label,
    normalizedKey: normalizeKey(label),
    value: String(value),
    category,
    confidence: 'medium',
    sourceLine: '',
  })
}

function formatValue(value) {
  return value === undefined || value === null || value === '' ? 'Not available' : String(value)
}

// -- Part 1: header fields ------------------------------------------------------

function buildPart1Fields(parsed) {
  const fields = []
  addField(fields, 'Invoice No', parsed.invoiceNo, 'id')
  addField(fields, 'FI Doc', parsed.fiDoc, 'id')
  addField(fields, 'Challan Date', parsed.challanDate, 'date')
  addField(fields, 'Reason', parsed.reason, 'other')
  addField(fields, 'PO No', parsed.poNo, 'id')
  addField(fields, 'Request No', parsed.requestNo, 'id')
  addField(fields, 'IRN No', parsed.irnNo, 'id')

  addField(fields, 'Consignee Code', parsed.consignee?.code, 'id')
  addField(fields, 'Consignee Name', parsed.consignee?.name, 'name')
  addField(fields, 'Consignee Address', parsed.consignee?.address, 'address')
  addField(fields, 'Consignee State', parsed.consignee?.stateName, 'address')
  addField(fields, 'Consignee GSTIN', parsed.consignee?.gstin, 'gst')
  addField(fields, 'Consignee PAN', parsed.consignee?.pan, 'id')

  addField(fields, 'Consignor Name', parsed.consignor?.name, 'name')
  addField(fields, 'Consignor Address', parsed.consignor?.address, 'address')
  addField(fields, 'Consignor State', parsed.consignor?.stateName, 'address')
  addField(fields, 'Consignor GSTIN', parsed.consignor?.gstin, 'gst')
  addField(fields, 'Consignor PAN', parsed.consignor?.pan, 'id')

  return fields
}

function buildPart1Summary(parsed) {
  const lines = [
    'HEADER (PART 1):',
    `Invoice No: ${formatValue(parsed.invoiceNo)}`,
    `FI Doc: ${formatValue(parsed.fiDoc)}`,
    `Challan Date: ${formatValue(parsed.challanDate)}`,
    `Reason: ${formatValue(parsed.reason)}`,
    `PO No: ${formatValue(parsed.poNo)}`,
    `Request No: ${formatValue(parsed.requestNo)}`,
    `IRN No: ${formatValue(parsed.irnNo)}`,
    '',
    'CONSIGNEE:',
    `Code: ${formatValue(parsed.consignee?.code)}`,
    `Name: ${formatValue(parsed.consignee?.name)}`,
    `Address: ${formatValue(parsed.consignee?.address)}`,
    `State: ${formatValue(parsed.consignee?.stateName)}`,
    `GSTIN: ${formatValue(parsed.consignee?.gstin)}`,
    `PAN: ${formatValue(parsed.consignee?.pan)}`,
    '',
    'CONSIGNOR:',
    `Name: ${formatValue(parsed.consignor?.name)}`,
    `Address: ${formatValue(parsed.consignor?.address)}`,
    `State: ${formatValue(parsed.consignor?.stateName)}`,
    `GSTIN: ${formatValue(parsed.consignor?.gstin)}`,
    `PAN: ${formatValue(parsed.consignor?.pan)}`,
  ]
  return lines.join('\n')
}

// -- Part 2: line items + totals ------------------------------------------------

function buildPart2Tables(parsed) {
  const tables = []
  const items = Array.isArray(parsed.lineItems) ? parsed.lineItems : []

  if (items.length) {
    tables.push({
      title: 'Line Items',
      confidence: 'medium',
      columns: ['SR No', 'Description', 'HSN/SAC', 'Basic', 'Quantity', 'Amount'],
      rows: items.map(item => ({
        'SR No': item.srNo || '',
        Description: item.description || '',
        'HSN/SAC': item.hsnSac || '',
        Basic: item.basic || '',
        Quantity: item.quantity || '',
        Amount: item.amount || '',
      })),
      sourceHint: 'UNCODED RGP line-items table',
    })
  }

  // Always show every tax/total row, even when unread - dropping a null CGST/SGST/IGST
  // row silently made the "Taxes" view look like it only ever extracts monetary
  // totals (no tax fields), when really the tax rows were just hidden, not missing
  // from the schema. "Not available" makes an extraction gap visible instead of
  // making it look like tax fields were never a thing this pipeline extracts.
  const totals = parsed.totals || {}
  const totalRows = [
    ['Total Basic Amount', totals.totalBasicAmount],
    ['CGST', totals.cgst],
    ['SGST', totals.sgst],
    ['IGST', totals.igst],
    ['Total Amount', totals.totalAmount],
  ].map(([Field, Value]) => ({ Field, Value: formatValue(Value) }))

  tables.push({
    title: 'Totals',
    confidence: 'medium',
    columns: ['Field', 'Value'],
    rows: totalRows,
    sourceHint: 'Line-items table tax/total footer',
  })

  return tables
}

// Flat field entries for Totals + Line Items so the existing field-correction
// endpoint (PATCH /documents/:id/fields/:fieldKey/correct) can edit them the
// same way it already edits Part 1 header fields - no new save logic needed.
// Unlike addField, always creates the field even when the value is null - used
// for the fixed set of tax/total rows so they stay editable (fillable by hand)
// even when the AI couldn't read them, instead of the field just not existing.
function addFieldAlways(fields, label, value, category = 'other') {
  fields.push({
    label,
    normalizedKey: normalizeKey(label),
    value: value === undefined || value === null || value === '' ? null : String(value),
    category,
    confidence: 'medium',
    sourceLine: '',
  })
}

function buildPart2Fields(parsed) {
  const fields = []
  const totals = parsed.totals || {}

  addFieldAlways(fields, 'Total Basic Amount', totals.totalBasicAmount, 'amount')
  addFieldAlways(fields, 'CGST', totals.cgst, 'tax')
  addFieldAlways(fields, 'SGST', totals.sgst, 'tax')
  addFieldAlways(fields, 'IGST', totals.igst, 'tax')
  addFieldAlways(fields, 'Total Amount', totals.totalAmount, 'amount')

  const items = Array.isArray(parsed.lineItems) ? parsed.lineItems : []
  items.forEach((item, i) => {
    const n = i + 1
    addField(fields, `Item ${n} - SR No`, item.srNo, 'id')
    addField(fields, `Item ${n} - Description`, item.description, 'other')
    addField(fields, `Item ${n} - HSN/SAC`, item.hsnSac, 'id')
    addField(fields, `Item ${n} - Basic`, item.basic, 'amount')
    addField(fields, `Item ${n} - Quantity`, item.quantity, 'other')
    addField(fields, `Item ${n} - Amount`, item.amount, 'amount')
  })

  return fields
}

function buildPart2Summary(parsed) {
  const items = Array.isArray(parsed.lineItems) ? parsed.lineItems : []
  const totals = parsed.totals || {}
  const lines = [
    'LINE ITEMS (PART 2):',
    `Total line items: ${items.length}`,
    ...items.map((item, i) => `${i + 1}. [SR ${formatValue(item.srNo)}] ${formatValue(item.description)} | HSN ${formatValue(item.hsnSac)} | Basic ${formatValue(item.basic)} | Qty ${formatValue(item.quantity)} | Amount ${formatValue(item.amount)}`),
    '',
    'TOTALS:',
    `Total Basic Amount: ${formatValue(totals.totalBasicAmount)}`,
    `CGST: ${formatValue(totals.cgst)}`,
    `SGST: ${formatValue(totals.sgst)}`,
    `IGST: ${formatValue(totals.igst)}`,
    `Total Amount: ${formatValue(totals.totalAmount)}`,
  ]
  return lines.join('\n')
}

// -- Combined document -----------------------------------------------------------

function buildCombinedSummary(part1Parsed, part2Parsed) {
  return [buildPart1Summary(part1Parsed), '', buildPart2Summary(part2Parsed)].join('\n')
}

function buildCombinedFields(part1Parsed, part2Parsed) {
  return [...buildPart1Fields(part1Parsed), ...buildPart2Fields(part2Parsed)]
}

function buildCombinedTables(part1Parsed, part2Parsed) {
  const partyRows = [
    {
      Role: 'Consignee',
      Name: part1Parsed.consignee?.name || '',
      GSTIN: part1Parsed.consignee?.gstin || '',
      PAN: part1Parsed.consignee?.pan || '',
    },
    {
      Role: 'Consignor',
      Name: part1Parsed.consignor?.name || '',
      GSTIN: part1Parsed.consignor?.gstin || '',
      PAN: part1Parsed.consignor?.pan || '',
    },
  ]

  return [
    {
      title: 'Parties',
      confidence: 'medium',
      columns: ['Role', 'Name', 'GSTIN', 'PAN'],
      rows: partyRows,
      sourceHint: 'Part 1 header fields',
    },
    ...buildPart2Tables(part2Parsed),
  ]
}

// Backend safety net: drop any line item the AI produced that doesn't hold up as
// a real row, regardless of what the prompt asked for. A genuine row always has
// a readable description with real words in it; a hallucinated/misparsed row
// (e.g. a stray footer number attached to noise like "2 S---") does not.
function isGarbageLineItem(item) {
  const desc = (item?.description || '').trim()
  const letters = (desc.match(/[a-zA-Z]/g) || []).length
  if (letters < 3) return true
  // A row with no HSN/SAC, no quantity, and no basic amount alongside a near-empty
  // description is almost always a misattributed footer value, not a real item.
  if (!item.hsnSac && !item.quantity && !item.basic && letters < 6) return true
  return false
}

function sanitizeLineItems(lineItems, warnings) {
  const items = Array.isArray(lineItems) ? lineItems : []
  const kept = []
  for (const item of items) {
    if (isGarbageLineItem(item)) {
      warnings.push(`Dropped an unreadable/garbled line item row (SR ${item?.srNo ?? 'unknown'}) rather than showing incorrect data.`)
      continue
    }
    kept.push(item)
  }
  return kept
}

function buildSummaryPoints(part1Like, part2Like) {
  const items = Array.isArray(part2Like.lineItems) ? part2Like.lineItems : []
  return [
    `Consignee: ${formatValue(part1Like.consignee?.name)}; Consignor: ${formatValue(part1Like.consignor?.name)}.`,
    `Invoice No: ${formatValue(part1Like.invoiceNo)}, dated ${formatValue(part1Like.challanDate)}.`,
    `Line items: ${items.length}.`,
    `Total Amount: ${formatValue(part2Like.totals?.totalAmount)}.`,
  ]
}

// Single place that turns canonical structured data (consignee/consignor/totals/
// lineItems/header scalars) into every derived view (fields, tables, summaries,
// part1/part2 breakdowns). Used both right after AI extraction AND after a manual
// field correction, so a correction regenerates every view from the one updated
// source instead of leaving stale copies anywhere.
function assembleDocumentViews(part1Like, part2Like) {
  return {
    part1: {
      fields: buildPart1Fields(part1Like),
      summary: buildPart1Summary(part1Like),
    },
    part2: {
      fields: buildPart2Fields(part2Like),
      tables: buildPart2Tables(part2Like),
      summary: buildPart2Summary(part2Like),
    },
    fields: buildCombinedFields(part1Like, part2Like),
    tables: buildCombinedTables(part1Like, part2Like),
    fullSummary: buildCombinedSummary(part1Like, part2Like),
    summaryPoints: buildSummaryPoints(part1Like, part2Like),
  }
}

// Maps a field's normalizedKey back to where that value lives in the canonical
// structured document, so a correction can be written once to the real source
// (not just patched into a display copy) - single-field/scalar entries below,
// line-item entries (item_<n>_<column>) are handled separately in applyCorrection.
const FIELD_KEY_PATH = {
  invoice_no: ['invoiceNo'],
  fi_doc: ['fiDoc'],
  challan_date: ['challanDate'],
  reason: ['reason'],
  po_no: ['poNo'],
  request_no: ['requestNo'],
  irn_no: ['irnNo'],
  consignee_code: ['consignee', 'code'],
  consignee_name: ['consignee', 'name'],
  consignee_address: ['consignee', 'address'],
  consignee_state: ['consignee', 'stateName'],
  consignee_gstin: ['consignee', 'gstin'],
  consignee_pan: ['consignee', 'pan'],
  consignor_name: ['consignor', 'name'],
  consignor_address: ['consignor', 'address'],
  consignor_state: ['consignor', 'stateName'],
  consignor_gstin: ['consignor', 'gstin'],
  consignor_pan: ['consignor', 'pan'],
  total_basic_amount: ['totals', 'totalBasicAmount'],
  cgst: ['totals', 'cgst'],
  sgst: ['totals', 'sgst'],
  igst: ['totals', 'igst'],
  total_amount: ['totals', 'totalAmount'],
}

const ITEM_FIELD_PROP = {
  sr_no: 'srNo',
  description: 'description',
  hsn_sac: 'hsnSac',
  basic: 'basic',
  quantity: 'quantity',
  amount: 'amount',
}

// Mutates `canonical` in place, writing `value` into the real field the
// normalizedKey refers to. Returns false if the key isn't a known editable field.
function applyCorrection(canonical, normalizedKey, value) {
  const itemMatch = normalizedKey.match(/^item_(\d+)_(.+)$/)
  if (itemMatch) {
    const index = parseInt(itemMatch[1], 10) - 1
    const prop = ITEM_FIELD_PROP[itemMatch[2]]
    if (!prop || !Array.isArray(canonical.lineItems) || !canonical.lineItems[index]) return false
    canonical.lineItems[index][prop] = value
    return true
  }

  const fieldPath = FIELD_KEY_PATH[normalizedKey]
  if (!fieldPath) return false
  if (fieldPath.length === 1) {
    canonical[fieldPath[0]] = value
  } else {
    const [objectKey, prop] = fieldPath
    if (!canonical[objectKey]) canonical[objectKey] = {}
    canonical[objectKey][prop] = value
  }
  return true
}

async function analyzeDocument({ part1Text, part2Text }) {
  const [part1Parsed, part2Parsed] = await Promise.all([
    part1Text ? runExtraction(PART1_SYSTEM, part1Text, 'consignee/consignor header') : Promise.resolve({}),
    part2Text ? runExtraction(PART2_SYSTEM, part2Text, 'line-items table') : Promise.resolve({}),
  ])

  const warnings = [
    ...(Array.isArray(part1Parsed.warnings) ? part1Parsed.warnings : []),
    ...(Array.isArray(part2Parsed.warnings) ? part2Parsed.warnings : []),
  ]

  part2Parsed.lineItems = sanitizeLineItems(part2Parsed.lineItems, warnings)

  // Header metadata usually comes from Part 1, but the automatic page split can
  // occasionally place a line or two on the Part 2 side - fall back to Part 2's
  // safety-net capture of the same fields when Part 1 didn't find them.
  const pick = (key) => part1Parsed[key] ?? part2Parsed[key] ?? null

  const part1Like = {
    consignee: part1Parsed.consignee || null,
    consignor: part1Parsed.consignor || null,
    invoiceNo: pick('invoiceNo'),
    fiDoc: pick('fiDoc'),
    challanDate: pick('challanDate'),
    reason: pick('reason'),
    poNo: pick('poNo'),
    requestNo: pick('requestNo'),
    irnNo: pick('irnNo'),
  }
  const part2Like = {
    lineItems: Array.isArray(part2Parsed.lineItems) ? part2Parsed.lineItems : [],
    totals: part2Parsed.totals || null,
  }

  return {
    documentType: 'Delivery Challan - Consignor/Consignee',
    ...part1Like,
    ...part2Like,
    warnings,
    ...assembleDocumentViews(part1Like, part2Like),
  }
}

const CHAT_SYSTEM = `You are a Consignor-Consignee delivery challan Q&A assistant. Answer questions ONLY from the document context provided below.

RULES:
- Use ONLY the document data provided - never use general knowledge
- If a field is not in the document: say "This information is not available in this document."
- Be direct and specific - give exact values, not descriptions
- For amounts: always include the currency (Rs.)

QUICK COMMANDS - recognize these and respond accordingly:
- "Show consignee" -> Consignee name, code, address, GSTIN, PAN
- "Show consignor" -> Consignor name, address, GSTIN, PAN
- "Show invoice" or "invoice number" -> Invoice No, FI Doc, Date
- "Show line items" or "show items" -> Full line-items table
- "Show totals" or "show amount" -> Total Basic Amount, CGST, SGST, IGST, Total Amount
- "Summarize" -> All key fields in a clean numbered list
- "Show all fields" -> Every field with its value

TERMS TO UNDERSTAND:
- Consignee = the receiving party
- Consignor = the sending party (VE Commercial Vehicles Ltd)
- FI Doc = internal financial document reference number
- UNCODED RGP = the line-items table section of the challan
- HSN/SAC = tax classification code for each item`

async function answerQuestion(question, docContext) {
  const { fields = [], tables = [], summaryPoints = [], ocrText = '' } = docContext

  const contextBlock = `
=== DOCUMENT SUMMARY ===
${summaryPoints.length ? summaryPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') : 'None'}

=== EXTRACTED FIELDS ===
${fields.length
    ? fields.map(f => `${f.label}: ${f.value ?? 'N/A'} [${f.category || 'other'}]`).join('\n')
    : 'None'}

=== EXTRACTED TABLES ===
${tables.length
    ? tables.map(t => {
        const cols = (t.columns || []).join(' | ')
        const rows = (t.rows || []).map(r => (t.columns || []).map(c => r[c] ?? '-').join(' | ')).join('\n')
        return `Table: ${t.title || 'Unnamed'}\nColumns: ${cols}\n${rows}`
      }).join('\n\n')
    : 'None'}

=== RAW OCR TEXT ===
${ocrText || '(not available)'}`

  const response = await callGroqWithFailover(client => client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: CHAT_SYSTEM + '\n\n' + contextBlock },
      { role: 'user', content: question },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  }))

  return response.choices[0].message.content
}

module.exports = {
  analyzeDocument,
  answerQuestion,
  assembleDocumentViews,
  applyCorrection,
}
