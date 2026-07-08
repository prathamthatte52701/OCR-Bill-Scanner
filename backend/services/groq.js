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
let nextKeyIndex = 0

function getClient() {
  if (keyPool === null) keyPool = getKeyPool()
  if (!keyPool.length) throw new Error('GROQ_API_KEY (or GROQ_API_KEYS) is not set')
  const apiKey = keyPool[nextKeyIndex % keyPool.length]
  nextKeyIndex++
  return new Groq({ apiKey })
}

const PRINTED_ONLY_RULE = `
CRITICAL - PRINTED TEXT ONLY:
- This OCR text may contain handwritten notes, rubber-stamp text, signatures, or pen marks mixed in with the machine-printed form.
- Extract ONLY values that belong to the machine-printed form fields and table.
- IGNORE anything that reads like a handwritten annotation, a stamp (e.g. "OUT-WARD UNIT", "SECURITY", "Sr. No ... Time Out ... Vh No", company rubber-stamp blocks), a signature name, or loose numbers/notes scribbled outside the form's own bordered cells.
- If a printed field's value is genuinely obscured or unreadable because a stamp/pen mark overlaps it, set that field to null and add a warning - do NOT guess or substitute the handwritten text for it.`

const PART1_SYSTEM = `You are a document extraction specialist for Indian "Delivery Challan" (Consignor-Consignee) documents issued under Rule 55 of CGST Rule.

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

CHARACTER CORRECTION RULES - MANDATORY - APPLY BEFORE RETURNING GSTIN/PAN:
GSTIN format is always: 2 digits + 5 letters + 4 digits + 1 letter + 1 digit + "Z" + 1 digit (15 characters total).
PAN format is always: 5 letters + 4 digits + 1 letter (10 characters total).
OCR commonly confuses these characters - correct them using surrounding position context:
- Position 13 of a GSTIN (the checksum-entity-code letter) is ALWAYS "Z" - if OCR shows "2", "7", or any digit there, correct it to "Z"
- Where a DIGIT is expected but OCR shows a letter: S->5, O->0, I->1, Z->2, B->8, G->6
- Where a LETTER is expected but OCR shows a digit: 5->S, 0->O, 1->I, 2->Z, 8->B, 6->G
- Apply this positionally (digits-block vs letters-block per the format above), not by guessing
- Log every correction you make in warnings, e.g. "Consignee GSTIN position 13: corrected 2->Z"
- If a GSTIN/PAN is too garbled to confidently reconstruct the format, leave it as the best-effort OCR value and add a warning instead of fabricating characters
${PRINTED_ONLY_RULE}

NULL RULES:
- null for every missing or unreadable field - never fabricate any value
- Use warnings[] to log every field that was unclear, partially read, or excluded due to stamp/handwriting overlap`

const PART2_SYSTEM = `You are a document extraction specialist for Indian "Delivery Challan" (Consignor-Consignee) documents issued under Rule 55 of CGST Rule.

You will receive OCR text from the LOWER section of the bill only - this section is a single bordered table titled "UNCODED RGP" listing line items (SR No, Description, HSN/SAC, Basic, Quantity, Amount), followed by a totals footer (Total Basic Amount, CGST, SGST, IGST, Total Amount).

NOTE: The page split is done automatically and its exact cut line varies slightly bill to bill. Sometimes a few header metadata lines (Invoice No, FI Doc, Date, Reason, Request No, IRN No) that normally belong to the section above end up included at the very TOP of this OCR text, above "UNCODED RGP". If you see any of them, extract them too - they are a safety-net capture, not the primary content of this section.

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
  "requestNo": "Request No value if present at the top of this text, else null",
  "irnNo": "IRN No value if present at the top of this text, else null",
  "warnings": []
}

RULES - MANDATORY:
- Extract EVERY line item row. Do not skip, merge, or summarize rows - each printed row in the table must become one entry in lineItems.
- Preserve the SR No exactly as printed even if numbering does not start at 1 - do not renumber rows.
- Amount/Basic fields contain only digits, commas, and decimal point.
- CGST/SGST/IGST rows may show "0.00" as a genuine printed value - keep it as "0.00", do not convert to null.
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
  const client = getClient()
  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Extract all information from this ${label} OCR text:\n\n${ocrText}` },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  })
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

  const totals = parsed.totals || {}
  const totalRows = [
    ['Total Basic Amount', totals.totalBasicAmount],
    ['CGST', totals.cgst],
    ['SGST', totals.sgst],
    ['IGST', totals.igst],
    ['Total Amount', totals.totalAmount],
  ]
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([Field, Value]) => ({ Field, Value: String(Value) }))

  if (totalRows.length) {
    tables.push({
      title: 'Totals',
      confidence: 'medium',
      columns: ['Field', 'Value'],
      rows: totalRows,
      sourceHint: 'Line-items table tax/total footer',
    })
  }

  return tables
}

// Flat field entries for Totals + Line Items so the existing field-correction
// endpoint (PATCH /documents/:id/fields/:fieldKey/correct) can edit them the
// same way it already edits Part 1 header fields - no new save logic needed.
function buildPart2Fields(parsed) {
  const fields = []
  const totals = parsed.totals || {}

  addField(fields, 'Total Basic Amount', totals.totalBasicAmount, 'amount')
  addField(fields, 'CGST', totals.cgst, 'tax')
  addField(fields, 'SGST', totals.sgst, 'tax')
  addField(fields, 'IGST', totals.igst, 'tax')
  addField(fields, 'Total Amount', totals.totalAmount, 'amount')

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

async function analyzeDocument({ part1Text, part2Text }) {
  const [part1Parsed, part2Parsed] = await Promise.all([
    part1Text ? runExtraction(PART1_SYSTEM, part1Text, 'consignee/consignor header') : Promise.resolve({}),
    part2Text ? runExtraction(PART2_SYSTEM, part2Text, 'line-items table') : Promise.resolve({}),
  ])

  const warnings = [
    ...(Array.isArray(part1Parsed.warnings) ? part1Parsed.warnings : []),
    ...(Array.isArray(part2Parsed.warnings) ? part2Parsed.warnings : []),
  ]

  // Header metadata usually comes from Part 1, but the automatic page split can
  // occasionally place a line or two on the Part 2 side - fall back to Part 2's
  // safety-net capture of the same fields when Part 1 didn't find them.
  const pick = (key) => part1Parsed[key] ?? part2Parsed[key] ?? null

  return {
    documentType: 'Delivery Challan - Consignor/Consignee',
    consignee: part1Parsed.consignee || null,
    consignor: part1Parsed.consignor || null,
    invoiceNo: pick('invoiceNo'),
    fiDoc: pick('fiDoc'),
    challanDate: pick('challanDate'),
    reason: pick('reason'),
    poNo: part1Parsed.poNo || null,
    requestNo: pick('requestNo'),
    irnNo: pick('irnNo'),
    lineItems: Array.isArray(part2Parsed.lineItems) ? part2Parsed.lineItems : [],
    totals: part2Parsed.totals || null,
    warnings,

    part1: {
      fields: buildPart1Fields(part1Parsed),
      summary: buildPart1Summary(part1Parsed),
    },
    part2: {
      fields: buildPart2Fields(part2Parsed),
      tables: buildPart2Tables(part2Parsed),
      summary: buildPart2Summary(part2Parsed),
    },

    // Combined view - one document, all data together
    fields: buildCombinedFields(part1Parsed, part2Parsed),
    tables: buildCombinedTables(part1Parsed, part2Parsed),
    fullSummary: buildCombinedSummary(part1Parsed, part2Parsed),
    summaryPoints: [
      `Consignee: ${formatValue(part1Parsed.consignee?.name)}; Consignor: ${formatValue(part1Parsed.consignor?.name)}.`,
      `Invoice No: ${formatValue(part1Parsed.invoiceNo)}, dated ${formatValue(part1Parsed.challanDate)}.`,
      `Line items: ${Array.isArray(part2Parsed.lineItems) ? part2Parsed.lineItems.length : 0}.`,
      `Total Amount: ${formatValue(part2Parsed.totals?.totalAmount)}.`,
    ],
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
  const client = getClient()
  const { fields = [], tables = [], summaryPoints = [], ocrText = '' } = docContext

  const contextBlock = `
=== DOCUMENT SUMMARY ===
${summaryPoints.length ? summaryPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') : 'None'}

=== EXTRACTED FIELDS ===
${fields.length
    ? fields.map(f => `${f.label}: ${f.correctedValue ?? f.value ?? 'N/A'} [${f.category || 'other'}]`).join('\n')
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

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: CHAT_SYSTEM + '\n\n' + contextBlock },
      { role: 'user', content: question },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  })

  return response.choices[0].message.content
}

module.exports = {
  analyzeDocument,
  answerQuestion,
}
