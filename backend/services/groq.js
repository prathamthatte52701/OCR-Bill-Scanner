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
- LABELS ARE OFTEN TRUNCATED BY OCR - the leading character(s) of a label are frequently cut off or merged with the previous line. Recognize a label from a distinctive trailing fragment even if the start is missing: "oice No" / "nvoice No" = "Invoice No", "TIN No" = "GSTIN No", "onsignee" = "Consignee", "eason" = "Reason", "equest No" = "Request No". Do not require an exact full-word match on the label before extracting the value that follows it.

CONSIGNEE vs CONSIGNOR DISAMBIGUATION - CRITICAL:
- The OCR text loses the visual left/right column boundary, so lines from both parties often appear interleaved, merged, or out of order.
- Everything from the start of the text up to (and not including) the line that introduces "VE Commercial Vehicles" / the Consignor's "Name" row belongs to Consignee. Everything from that point onward belongs to Consignor, until a field label clearly says "Consignee" again.
- Never let an address fragment, state code, GSTIN, or PAN that belongs to one party end up attached to the other party just because the OCR lines were adjacent or out of order. If you cannot confidently tell which party a fragment belongs to, leave that specific sub-field null rather than attaching it to the wrong party.

ADDRESS BOUNDARY RULE - CRITICAL (prevents cross-party address mixing):
- On the printed form, "Address" is its own label on one line, and the actual street/city/pincode text appears as UNLABELED lines directly below it - this is why address lines are the easiest to misattach to the wrong party.
- The Address value for a party is ONLY the text that appears strictly between that party's own "Address" label and the NEXT recognized label for that SAME party (GSTIN No, PAN No, State Code, or the other party's Name/Consignor/Consignee marker) - whichever comes first.
- Stop collecting address lines the moment you hit any of: "State Code", "GSTIN No", "PAN No", "VECV GSTIN No", "VECV PAN No", "Name", "Invoice No", "PO No." - text after one of these belongs to a different field or the other party, never to the address you were building.
- Do NOT carry a street/building line (e.g. "87A Industrial Area...", "A. B Road Dewas") into the OTHER party's address just because it appeared near their address lines in the flattened text - each party's address lines sit only under that party's own "Address" label.

REFERENCE VALUES - this document type always has the same Consignor, and the same Consignee company (only branch details differ). Use these ONLY to sanity-check and correct clearly OCR-garbled values, never to overwrite a value that is already clearly and consistently read as something else in the text:
- Consignor is always: name "VE Commercial Vehicles Ltd (UNIT - EEC)", state "Madhya Pradesh", stateCode "23", gstin "23AABCE9378F3ZI", pan "AABCE9378F".
- Consignor ADDRESS is the one exception with NO single fixed reference - it genuinely varies between two different printed prefixes across real bills: "87A Industrial Area No 3, A. B Road Dewas, 455001" on some bills, "78-86 Industrial Area No 3, A. B Road Dewas, 455001" on others. Read whichever prefix is ACTUALLY printed in the OCR text for this specific document - do not default to "87A" (or either variant) as a fallback guess when the address is unclear. If you truly cannot tell which prefix is printed, return null for the address rather than guessing one of the two.
- Consignee company name is always "OERLIKON BALZERS COATING INDIA" and pan is always "AAACI3916N" regardless of branch; consignee address/state/stateCode/gstin vary by branch and must come from the OCR text, not from this reference.
- If a value you're about to output for Consignor differs from its reference value, re-check whether it actually belongs to Consignee instead (a column mix-up) before accepting it as a genuine difference.

CHARACTER CORRECTION RULES - CONSERVATIVE, NEVER FABRICATE:
GSTIN format is always: 2 digits + 5 letters + 4 digits + 1 letter + 1 digit + "Z" + 1 digit (15 characters total).
PAN format is always: 5 letters + 4 digits + 1 letter (10 characters total).
- A "correction" ONLY means swapping ONE character that OCR clearly rendered as a specific, different, visually-similar character in that exact position - e.g. the OCR text shows a real "5" where a letter is expected, and you change it to "S". Known confusable pairs: S<->5, O<->0, I<->1, Z<->2, B<->8, G<->6, and position-13 of a GSTIN which is always "Z".
- A correction is NEVER filling in a character that is missing, blank, unreadable, or represented by a placeholder (blank space, "?", "_", "X", or similar) in the source. If a character position has nothing legible there at all, that position stays missing - represent the field as the partial string you DID read (see NULL RULES below), do not complete it using the GSTIN/PAN format, the reference values, or any other pattern-based guess.
- Test yourself before outputting a correction: can you point to the EXACT wrong character OCR actually printed at that position? If yes, correct it. If the honest answer is "there's nothing there to point to, but I know what it should probably be," that is fabrication - do not do it.
- NEVER write a justification like "assuming..." or "using standard format" or "corrected X->Y" where X is blank/placeholder rather than a real misread character - if you find yourself doing that, you are fabricating.
- Log every genuine single-character correction in warnings, e.g. "Consignee GSTIN position 13: corrected 2->Z"
${PRINTED_ONLY_RULE}

NULL RULES - CRITICAL DISTINCTION:
- null means "the OCR text contains NOTHING for this field" - no characters, no fragment, nothing to point to.
- If the OCR text contains SOME real, legible characters for a field but not the complete value, return exactly those characters as a partial string (e.g. GSTIN "24AAAC...16N1ZI" with the unreadable middle segment simply omitted, not guessed) rather than nulling the whole field. Do not discard real (if incomplete) OCR output just because it isn't the full value.
- Do NOT pad the partial string out to the expected length by inventing the missing characters - that is fabrication, covered above. A partial value is allowed to be the "wrong" length.
- Whenever you return a partial/uncertain fragment instead of a clean complete value, say so in warnings (e.g. "Consignee PAN partially read: 'AAAC...16N' - middle characters not legible in the source").
- Never fabricate a value that has zero basis in the OCR text - that is the only thing "never fabricate" means. It does NOT mean "when in doubt, return null" for a field you DID find real text for.`

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
- The table has exactly this column order left to right: SR No, Description, HSN/SAC, Basic, Quantity, Amount. Basic and Amount are usually the two largest numbers in the row (item's unit price and line total) and are usually similar or identical when Quantity is 1; Quantity is almost always a small 1-2 digit whole number (1, 2, 3...), never a number formatted with a decimal point and two trailing zeros like "10,000.00". If the value you are about to place in "quantity" looks like a large formatted currency amount rather than a small whole number, you have most likely misread the column boundary - re-check which OCR token is actually under the Quantity column heading before assigning it.
${PRINTED_ONLY_RULE}

NULL RULES - CRITICAL DISTINCTION:
- null means "the OCR text contains NOTHING for this field" - no digits, no fragment, nothing to point to.
- If the OCR text contains SOME real, legible characters for a field (a partial HSN code, a smudged amount, a fragment of a description) but not the complete value, return exactly those characters as a partial string, never null and never padded out to a "complete-looking" value. Do not discard real (if incomplete) OCR output just because it isn't the full value. This does not override the earlier rule against fabricating a whole row that isn't really there - a row still needs a genuinely readable description to exist at all; this rule is about not nulling or completing individual fields WITHIN a row that does exist.
- Do NOT invent the missing portion of a partial field to make it look complete (e.g. a 6-digit HSN code with only 4 digits legible stays a 4-digit partial string, it does not get 2 more digits invented to match the expected format).
- Whenever you return a partial/uncertain fragment instead of a clean complete value, say so in warnings.
- If the line-items table is completely unreadable, return an empty lineItems array and explain in warnings
- Never fabricate a value that has zero basis in the OCR text - that is the only thing "never fabricate" means. It does NOT mean "when in doubt, return null" for a field you DID find real text for.`

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
  // addFieldAlways (not addField) so a null/"Not Available" value still gets a
  // field entry - otherwise the row (and its Edit button) doesn't exist at all.
  addFieldAlways(fields, 'Invoice No', parsed.invoiceNo, 'id')
  addFieldAlways(fields, 'FI Doc', parsed.fiDoc, 'id')
  addFieldAlways(fields, 'Challan Date', parsed.challanDate, 'date')
  addFieldAlways(fields, 'Reason', parsed.reason, 'other')
  addFieldAlways(fields, 'PO No', parsed.poNo, 'id')
  addFieldAlways(fields, 'Request No', parsed.requestNo, 'id')
  addFieldAlways(fields, 'IRN No', parsed.irnNo, 'id')

  addFieldAlways(fields, 'Consignee Code', parsed.consignee?.code, 'id')
  addFieldAlways(fields, 'Consignee Name', parsed.consignee?.name, 'name')
  addFieldAlways(fields, 'Consignee Address', parsed.consignee?.address, 'address')
  addFieldAlways(fields, 'Consignee State', parsed.consignee?.stateName, 'address')
  addFieldAlways(fields, 'Consignee GSTIN', parsed.consignee?.gstin, 'gst')
  addFieldAlways(fields, 'Consignee PAN', parsed.consignee?.pan, 'id')

  addFieldAlways(fields, 'Consignor Name', parsed.consignor?.name, 'name')
  addFieldAlways(fields, 'Consignor Address', parsed.consignor?.address, 'address')
  addFieldAlways(fields, 'Consignor State', parsed.consignor?.stateName, 'address')
  addFieldAlways(fields, 'Consignor GSTIN', parsed.consignor?.gstin, 'gst')
  addFieldAlways(fields, 'Consignor PAN', parsed.consignor?.pan, 'id')

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

  // Always push the Line Items table, even with zero rows - dropping the table
  // object entirely when OCR/AI couldn't read any row made the Uncoded RGP view
  // silently fall back to showing only Totals, indistinguishable from a working
  // extraction that just happened to have no line items. The frontend already
  // renders an explicit "No rows found." placeholder for an empty table - this
  // makes a genuine read failure visible instead of invisible.
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
    // addFieldAlways (not addField) so a null/missing cell in an existing row
    // still gets a field entry - otherwise that cell has no Edit button at all,
    // same fix already applied to Part 1's header fields.
    addFieldAlways(fields, `Item ${n} - SR No`, item.srNo, 'id')
    addFieldAlways(fields, `Item ${n} - Description`, item.description, 'other')
    addFieldAlways(fields, `Item ${n} - HSN/SAC`, item.hsnSac, 'id')
    addFieldAlways(fields, `Item ${n} - Basic`, item.basic, 'amount')
    addFieldAlways(fields, `Item ${n} - Quantity`, item.quantity, 'other')
    addFieldAlways(fields, `Item ${n} - Amount`, item.amount, 'amount')
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

// OCR/AI sometimes attaches a stray leading character to an otherwise-correct
// numeric field (currency symbol misread, a table-border pipe, a neighboring
// column's first digit) - e.g. "£00.00" or "| 700.00" where the real value is
// "700.00"/"900.00". Keep only the actual number pattern; leave the field
// untouched if it doesn't look like a number-with-noise (never invents a value).
function cleanNumericField(value) {
  if (value === null || value === undefined) return value
  const s = String(value).trim()
  // Prefer the LAST decimal-formatted number in the string, not the first
  // digit run - a garbage prefix is sometimes itself a lone digit ("| 3
  // 1,400.00"), and naively taking the first match would grab that stray "3"
  // instead of the real "1,400.00" that follows it.
  const decimalMatches = s.match(/\d[\d,]*\.\d{1,2}/g)
  if (decimalMatches && decimalMatches.length) return decimalMatches[decimalMatches.length - 1]
  const wholeMatches = s.match(/\d[\d,]*/g)
  if (wholeMatches && wholeMatches.length) return wholeMatches[wholeMatches.length - 1]
  return value
}

function cleanLineItemNumbers(items) {
  return items.map(item => ({
    ...item,
    basic: cleanNumericField(item.basic),
    quantity: cleanNumericField(item.quantity),
    amount: cleanNumericField(item.amount),
  }))
}

function normalizeDescriptionForMerge(desc) {
  return (desc || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

// Occasionally the AI reads the same printed row twice with different fields
// populated each time (one pass captures Basic+SR No, the next captures
// Quantity+Amount) instead of once cleanly - this shows up as two adjacent
// rows with an identical description where each has some fields null. Merge
// adjacent rows sharing a description into one, keeping whichever fields are
// non-null. Never merges rows with different descriptions (real distinct
// items on this template never repeat description text row-to-row).
function mergeDuplicateDescriptionRows(items, warnings) {
  const merged = []
  for (const item of items) {
    const prev = merged[merged.length - 1]
    const key = normalizeDescriptionForMerge(item.description)
    if (prev && key && normalizeDescriptionForMerge(prev.description) === key) {
      merged[merged.length - 1] = {
        srNo: prev.srNo || item.srNo,
        description: prev.description,
        hsnSac: prev.hsnSac || item.hsnSac,
        basic: prev.basic || item.basic,
        quantity: prev.quantity || item.quantity,
        amount: prev.amount || item.amount,
      }
      warnings.push(`Merged a duplicate-description row (SR ${item?.srNo ?? 'unknown'}) into the preceding row instead of showing it twice.`)
      continue
    }
    merged.push(item)
  }
  return merged
}

// On this template every row in a single UNCODED RGP table shares the same
// HSN/SAC code (e.g. all rows "998729") - when OCR reads it on some rows but
// misses it on others in the SAME document, fill the gaps with that one value
// instead of leaving them null. Only acts when every row that DID read an
// HSN/SAC agrees on the same value - if two different codes appear, that's
// evidence this document doesn't follow the single-code assumption, so leave
// the missing ones alone rather than guessing which one applies.
function applyHsnSacFallback(items, warnings) {
  if (!Array.isArray(items) || items.length < 2) return items

  const distinctCodes = new Set(items.map(i => i.hsnSac).filter(Boolean))
  if (distinctCodes.size !== 1) return items

  const [commonCode] = distinctCodes
  const missingCount = items.filter(i => !i.hsnSac).length
  if (missingCount === 0) return items

  warnings.push(`HSN/SAC filled as "${commonCode}" for ${missingCount} row(s) that were missing it, based on every other row in this table sharing that same code (deterministic rule).`)
  return items.map(item => item.hsnSac ? item : { ...item, hsnSac: commonCode })
}

// -- RULE T4: HSN/SAC majority consensus (extends/supersedes applyHsnSacFallback) --
//
// applyHsnSacFallback above only fires on unanimity (every readable code
// agrees). This is stronger and more useful when a table has >=3 rows
// carrying an HSN code and one code holds a strict majority (more than half):
// minority codes that differ from the majority code in <=2 character
// positions (same length only - a length mismatch is not a "close" OCR
// misread on a fixed-width code, it's a different reading altogether and is
// left alone) are normalized to the majority code, and null hsnSac cells are
// filled with the majority code too. Never invents a majority where none
// exists (ties/no-majority leave the table untouched).
function hsnCharDiffCount(a, b) {
  if (a.length !== b.length) return Infinity
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  return diff
}

function applyHsnMajorityRule(items, warnings) {
  if (!Array.isArray(items) || items.length === 0) return items

  const withCode = items.filter(i => i.hsnSac)
  if (withCode.length < 3) return items

  const counts = new Map()
  for (const i of withCode) counts.set(i.hsnSac, (counts.get(i.hsnSac) || 0) + 1)

  let majorityCode = null
  let majorityCount = 0
  for (const [code, count] of counts) {
    if (count > majorityCount) {
      majorityCount = count
      majorityCode = code
    }
  }
  if (!majorityCode || majorityCount <= withCode.length / 2) return items // no strict majority - nothing to trust

  return items.map(item => {
    if (!item.hsnSac) {
      warnings.push(`HSN/SAC (SR ${item.srNo ?? 'unknown'}) filled as "${majorityCode}" - majority code (${majorityCount}/${withCode.length} rows) across this table (deterministic rule).`)
      return { ...item, hsnSac: majorityCode }
    }
    if (item.hsnSac !== majorityCode && hsnCharDiffCount(item.hsnSac, majorityCode) <= 2) {
      warnings.push(`HSN/SAC (SR ${item.srNo ?? 'unknown'}) corrected from "${item.hsnSac}" to "${majorityCode}" - majority-code consensus (${majorityCount}/${withCode.length} rows), differs by <=2 character positions (deterministic rule).`)
      return { ...item, hsnSac: majorityCode }
    }
    return item
  })
}

function parseAmount(value) {
  if (value === null || value === undefined) return null
  const n = parseFloat(String(value).replace(/,/g, ''))
  return Number.isNaN(n) ? null : n
}

// On this template every real document is an interstate delivery (Gujarat
// consignee <-> Madhya Pradesh consignor) - CGST and SGST are always 0.00,
// only IGST ever carries a real value. When the CGST/SGST/IGST footer is
// badly garbled, the AI has occasionally attached the one real nonzero
// number to CGST or SGST instead of IGST. If exactly one of the three has a
// nonzero value and it isn't IGST, move it to IGST and zero the other two -
// this only fires when the source data is unambiguous about WHICH number is
// non-zero, it never invents a value that wasn't actually read.
function applyTotalsSanityRule(totals, warnings) {
  if (!totals) return totals
  const cgst = parseAmount(totals.cgst)
  const sgst = parseAmount(totals.sgst)
  const igst = parseAmount(totals.igst)

  const nonZero = [['cgst', cgst], ['sgst', sgst], ['igst', igst]].filter(([, v]) => v !== null && v !== 0)
  if (nonZero.length !== 1) return totals

  const [field] = nonZero[0]
  if (field === 'igst') return totals

  const originalValue = totals[field]
  warnings.push(`${field.toUpperCase()} value "${originalValue}" moved to IGST (deterministic rule: this template is always interstate, so only IGST is ever nonzero).`)
  return {
    ...totals,
    cgst: '0.00',
    sgst: '0.00',
    igst: originalValue,
  }
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

// This template has exactly two possible Consignee addresses (fixed to the
// detected State) and exactly two possible Consignor address prefixes - the
// address field is the largest source of extraction error because its value
// spans unlabeled continuation lines the AI has to reassemble from flattened
// text. Since only two outcomes are ever valid, replace the AI's guess with a
// deterministic lookup instead of trusting free-form reconstruction.
const CONSIGNEE_ADDRESS_BY_STATE = {
  gujarat: 'AHMEDABAD 382220',
  maharashtra: 'PUNE 411026',
}

function applyConsigneeAddressRule(consignee, warnings) {
  if (!consignee) return consignee
  const stateName = (consignee.stateName || '').toLowerCase()
  const matchedState = Object.keys(CONSIGNEE_ADDRESS_BY_STATE).find(s => stateName.includes(s))
  if (!matchedState) {
    warnings.push('Consignee state was not recognized as Gujarat or Maharashtra - address left as OCR-extracted rather than applying the deterministic rule.')
    return consignee
  }
  const canonicalAddress = CONSIGNEE_ADDRESS_BY_STATE[matchedState]
  if (consignee.address !== canonicalAddress) {
    warnings.push(`Consignee address set from the fixed ${matchedState[0].toUpperCase()}${matchedState.slice(1)} template value (deterministic rule), overriding OCR read "${consignee.address || 'null'}".`)
  }
  return { ...consignee, address: canonicalAddress }
}

function detectConsignorAddressPrefix(text) {
  if (/\b87\s*A\b/i.test(text)) return '87A Industrial Area No 3, A. B Road Dewas, 455001'
  if (/\b7[89][\s-]{0,3}[89]\d\b/i.test(text)) return '78-86 Industrial Area No 3, A. B Road Dewas, 455001'
  return null
}

function applyConsignorAddressRule(consignor, part1Text, warnings) {
  if (!consignor) return consignor
  // RULE 4 FINDING (see task write-up in the final report): this rule's
  // canonical-address detection must be sourced ONLY from the raw OCR text
  // (part1Text). The previous implementation fell back to
  // detectConsignorAddressPrefix(consignor.address) when the raw text didn't
  // match either prefix - but consignor.address is exactly the AI's own
  // (possibly hallucinated) output. That fallback let a hallucinated address
  // like "78-86 Industrial Area No 3, A. B Road Dewas, 455001" launder itself
  // back through detectConsignorAddressPrefix and come out looking like a
  // "confirmed" canonical value, with no warning raised (canonicalAddress
  // ended up equal to consignor.address, so the mismatch-warning branch never
  // fired). Removing the AI-address fallback closes that hole: if the raw
  // text has no confident 87A/78-86 evidence, the field is left as OCR-read
  // (with an explicit "could not confidently match" warning) instead of
  // silently re-trusting the AI's own guess.
  const canonicalAddress = detectConsignorAddressPrefix(part1Text || '')
  if (!canonicalAddress) {
    warnings.push('Consignor address prefix (87A vs 78-86) could not be confidently matched in the raw OCR text - address left as OCR-extracted rather than applying the deterministic rule.')
    return consignor
  }
  if (consignor.address !== canonicalAddress) {
    warnings.push(`Consignor address set from the fixed template value (deterministic rule), overriding OCR read "${consignor.address || 'null'}".`)
  }
  return { ...consignor, address: canonicalAddress }
}

// PO No is the other large source of extraction error: for digital PDFs,
// pdf-parse returns text in content-stream order rather than visual reading
// order, so the "PO No." label and its number can end up separated by dozens
// of unrelated tokens - the AI then either grabs the wrong nearby digit string
// (an HSN/SAC code, a line-item description) or correctly gives up (null).
// Every real PO No on this template is a 10-digit number starting "3242", so
// verify/recover it deterministically from the raw text instead of trusting
// label-adjacency parsing alone.
const PO_NO_PATTERN = /\b3242\d{6}\b/

function applyPoNoRule(poNo, part1Text, warnings) {
  const matchInText = (part1Text || '').match(PO_NO_PATTERN)?.[0] || null
  const currentIsValid = typeof poNo === 'string' && PO_NO_PATTERN.test(poNo)

  if (currentIsValid) return poNo

  if (matchInText) {
    if (poNo && poNo !== matchInText) {
      warnings.push(`PO No corrected from AI-extracted "${poNo}" (did not match the expected 3242-prefixed format) to "${matchInText}" found in the source text (deterministic rule).`)
    } else if (!poNo) {
      warnings.push(`PO No recovered as "${matchInText}" via deterministic pattern match (AI extraction returned null).`)
    }
    return matchInText
  }

  // No 3242-prefixed number anywhere in the text - leave as-is (including null),
  // never fabricate a value that isn't actually present in the source.
  return poNo
}

// FI Doc is always a pure digit string on this template (e.g. "1015002277").
// When OCR badly garbles the value, the AI has occasionally passed through
// whatever word-like noise Tesseract produced (e.g. "sides") as if it were the
// real value - same fabrication-adjacent problem isGarbageLineItem already
// guards against for line items. If the value contains any letters, it's not
// a real FI Doc reading - null it out instead of showing garbage as real data.
function applyFiDocGuard(fiDoc, warnings) {
  if (!fiDoc) return fiDoc
  if (/[a-zA-Z]/.test(fiDoc)) {
    warnings.push(`FI Doc value "${fiDoc}" discarded (not a valid digit string - likely OCR misread) and set to null instead of showing garbage as real data.`)
    return null
  }
  return fiDoc
}

// -- RULE 1: GSTIN checksum validation + reconstruction -------------------------
//
// Standard Indian GSTIN checksum (mod-36, base-36 charset, alternating 1/2
// weights over the first 14 characters). Used two ways below: (a) to confirm
// an already-15-char GSTIN is genuinely valid before leaving it untouched,
// and (b) to build reconstruction candidates from State Code + PAN, which are
// individually far more reliable OCR reads (short, high-contrast fields) than
// the 15-char GSTIN string itself.
const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function computeGstinChecksum(str14) {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARSET.indexOf(str14[i])
    if (value < 0) return null
    const weight = i % 2 === 0 ? 1 : 2
    const product = value * weight
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36]
}

function isValidGstin(gstin, stateCode, pan) {
  if (typeof gstin !== 'string' || gstin.length !== 15) return false
  if (stateCode && !gstin.startsWith(stateCode)) return false
  if (pan && gstin.slice(2, 12) !== pan) return false
  const checksum = computeGstinChecksum(gstin.slice(0, 14))
  return checksum !== null && gstin[14] === checksum
}

// Positional-match similarity between a reconstructed candidate and whatever
// OCR actually produced - purely a scoring heuristic, never used to invent
// characters, only to pick which fully-computed candidate (if any) is close
// enough to the OCR string to trust.
function scoreCandidatePositions(candidate, ocrGstin) {
  let score = 0
  const len = Math.min(candidate.length, ocrGstin.length)
  for (let i = 0; i < len; i++) if (candidate[i] === ocrGstin[i]) score++
  return score
}

// Builds every plausible 15-char GSTIN from a trusted State Code + PAN pair
// (entity code 1-9, "Z", computed checksum) and returns whichever one best
// matches the OCR-read gstin string, but ONLY if the match is strong enough
// to be confident it's the same document's GSTIN and not a coincidence -
// otherwise returns null and the OCR value is left untouched (never guess).
function reconstructGstin(stateCode, pan, ocrGstin) {
  if (!/^\d{2}$/.test(stateCode || '')) return null
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan || '')) return null

  let best = null
  let bestScore = -1
  for (const entityCode of '123456789') {
    const first14 = stateCode + pan + entityCode + 'Z'
    const checksum = computeGstinChecksum(first14)
    if (!checksum) continue
    const candidate = first14 + checksum
    const score = scoreCandidatePositions(candidate, ocrGstin || '')
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (!best) return null

  const first12Match =
    (ocrGstin || '').length >= 12 &&
    scoreCandidatePositions(best.slice(0, 12), ocrGstin.slice(0, 12)) >= 10
  if (bestScore >= 11 || first12Match) return best
  return null
}

// Repairs a single entity's (consignee/consignor) GSTIN in place. Can never
// make a previously-correct GSTIN worse: an already-valid 15-char GSTIN is
// left untouched (early return), reconstruction only runs off a trusted
// State Code + PAN pair (never off the untrusted gstin string itself), and
// a candidate is only adopted when it clears a high similarity bar against
// what OCR actually read - otherwise the OCR value (including null) is kept
// exactly as-is, since there is zero basis to invent one.
function repairGstin(entity, label, warnings) {
  if (!entity) return entity
  const { gstin, stateCode, pan } = entity
  if (!gstin) return entity // nothing to point to - never fabricate from scratch

  if (isValidGstin(gstin, stateCode, pan)) return entity // already correct - leave alone

  const candidate = reconstructGstin(stateCode, pan, gstin)
  if (!candidate) return entity // no confident basis - leave OCR value untouched

  warnings.push(
    `${label} GSTIN corrected to "${candidate}" - reconstructed from State Code + PAN with a computed GSTIN checksum (deterministic rule); OCR had read "${gstin}".`
  )
  return { ...entity, gstin: candidate }
}

// -- RULE 2: Reason subtitle blacklist + recovery --------------------------------
//
// The page subtitle "Transportation of goods for reasons other than by way of
// supply." is printed above the table on every single challan of this
// template - it is boilerplate, not the document's actual Reason value. The
// AI occasionally reads it into the Reason field because it's the nearest
// "Reason"-shaped sentence on the page. This rule can never make a genuinely
// correct Reason worse: it only fires when the value textually matches the
// known boilerplate sentence, and even then it prefers a real recovered value
// from the raw OCR "Reason" line over guessing - falling back to an honest
// null (with a warning) rather than ever keeping the wrong subtitle.
const REASON_SUBTITLE_PATTERN = /transportation\s+of\s+goo\w*s?\s*:?\s*for\s+reasons?\s+other\s+than/i
const REASON_LINE_PATTERN = /UNIT\s*[-:.]?\s*0?\d.*$/im

function applyReasonSubtitleRule(reason, part1Text, warnings) {
  if (typeof reason !== 'string' || !REASON_SUBTITLE_PATTERN.test(reason)) return reason

  const match = (part1Text || '').match(REASON_LINE_PATTERN)
  if (match) {
    const recovered = match[0].trim()
    warnings.push(
      `Reason corrected from the page subtitle ("${reason}") to "${recovered}" - recovered from the raw OCR "Reason" line (deterministic rule).`
    )
    return recovered
  }

  warnings.push(
    `Reason value "${reason}" discarded (it is the printed page subtitle, not the actual Reason field) and set to null - no genuine Reason line could be recovered from the raw OCR text.`
  )
  return null
}

// -- RULE 3: FI Doc rescue --------------------------------------------------------
//
// Never overrides a non-null fiDoc - this only runs to fill in a gap the AI
// left empty, using two independent, deterministic sources of evidence in
// order of reliability.
const FI_DOC_PATTERN = /\b1015\d{6}\b/g
const IRN_AS_FI_DOC_PATTERN = /^\d{10}$/
const FI_DOC_DIGIT_CONFUSION_PATTERN = /^1815\d{6}$/

function applyFiDocRescueRule(fiDoc, irnNo, part1Text, warnings) {
  if (fiDoc) return { fiDoc, irnNo } // already have a real value - never override

  // (a) Regex fallback: every FI Doc on this template is a 10-digit number
  // starting "1015". If exactly one distinct match exists in the raw text,
  // it's unambiguous; multiple distinct matches means we can't tell which
  // one is the real FI Doc, so skip rather than guess.
  const matches = [...((part1Text || '').match(FI_DOC_PATTERN) || [])]
  const distinct = [...new Set(matches)]
  if (distinct.length === 1) {
    warnings.push('FI Doc recovered from raw OCR text by pattern (deterministic rule).')
    return { fiDoc: distinct[0], irnNo }
  }

  // (b) irnNo misattribution: a real IRN is a 64-character hash. If irnNo
  // instead holds a pure 10-digit number, it is almost certainly the FI Doc
  // value that landed in the wrong field - move it back.
  if (typeof irnNo === 'string' && IRN_AS_FI_DOC_PATTERN.test(irnNo)) {
    let recovered = irnNo
    warnings.push(`FI Doc recovered from the irnNo field ("${irnNo}" is a 10-digit number, not a valid 64-character IRN hash) - value moved to FI Doc (deterministic rule).`)
    if (FI_DOC_DIGIT_CONFUSION_PATTERN.test(recovered)) {
      const corrected = '1015' + recovered.slice(4)
      warnings.push(`FI Doc prefix corrected from "1815" to "1015" (known 0<->8 OCR digit confusion on this template's fixed prefix, deterministic rule).`)
      recovered = corrected
    }
    return { fiDoc: recovered, irnNo: null }
  }

  return { fiDoc, irnNo }
}

// -- PART 2 POST-PROCESSING: rules A-F -------------------------------------------
//
// Deterministic repairs layered on top of the AI/grid line-items and totals,
// same style as the RULE 1-3 header repairs above: pure functions, a warning
// pushed for every automatic correction, never inventing a value with zero
// OCR basis, never making an already-correct value worse.

function parseMoney(s) {
  if (s === null || s === undefined) return null
  const n = parseFloat(String(s).replace(/,/g, '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

function looksCleanInt(s) {
  return typeof s === 'string' && /^\d{1,2}$/.test(s.trim())
}

function formatMoney(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '')
}

// Integer-rupee digits only (drops the ".00" decimal part, not just non-digit
// separators) - used to compare "money shape" across a correction without the
// decimal noise, e.g. moneyDigits("2,400.00") === "2400".
function moneyDigits(s) {
  if (s === null || s === undefined) return ''
  const n = parseMoney(s)
  if (n === null) return ''
  return String(Math.round(n))
}

// Edit distance capped at 2 (we only ever care whether it's <=1) - avoids
// pulling in a full Levenshtein implementation for a bounded check.
function editDistanceAtMost1(a, b) {
  if (a === b) return true
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    let diff = 0
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff++
    return diff <= 1
  }
  // one is exactly one character longer - check single insertion/deletion
  const [shorter, longer] = la < lb ? [a, b] : [b, a]
  let i = 0, j = 0, skipped = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true
    j++
  }
  return true
}

// "OCR-plausible": corrected digit string is a substring of (or contains) the
// original's digit string, or the two differ by at most one digit
// insertion/deletion/substitution.
function isOcrPlausible(originalStr, correctedStr) {
  const o = digitsOnly(originalStr)
  const c = digitsOnly(correctedStr)
  if (!o || !c) return false
  if (o.includes(c) || c.includes(o)) return true
  return editDistanceAtMost1(o, c)
}

// A money value on this template is always printed "1,234.00"/"900.00" -
// correctly grouped commas + exactly 2 decimals. A field NOT in that shape
// (e.g. "90000", "00") is itself evidence of an OCR misread (dropped the
// decimal point/comma), independent of the arithmetic - used as the primary
// tie-breaker below when more than one single-field correction is otherwise
// arithmetically valid and digit-plausible.
function isMoneyWellFormed(s) {
  return typeof s === 'string' && /^\d{1,3}(,\d{3})*\.\d{2}$/.test(s.trim())
}

// Among several arithmetically-valid, digit-plausible single-field
// corrections, picks the one most consistent with this codebase's known OCR
// noise pattern (documented in cleanNumericField): garbage is glued onto an
// otherwise-correct value, most often as an extra leading digit, so a
// candidate that REMOVES digits (deletion) from an already-odd-looking
// original is preferred over one that adds digits to an already-clean
// original. Returns the winning candidate, or null if the tie can't be
// broken (still ambiguous).
function pickBestRowCandidate(candidates, fieldOriginals) {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const ranked = candidates.map(cand => {
    const originalStr = fieldOriginals[cand.field]
    const malformedOriginal = cand.field === 'quantity' ? false : !isMoneyWellFormed(originalStr)
    const delta = digitsOnly(cand.value).length - digitsOnly(originalStr).length
    let rank
    if (malformedOriginal) rank = 0
    else if (delta < 0) rank = 1
    else if (delta > 0) rank = 2
    else rank = 3
    return { ...cand, rank }
  })

  // Secondary tie-break: Quantity is the narrowest, most OCR-error-prone
  // column on this template (documented in grid-line-items.js - the digit-only
  // worker exists specifically because the shared prose worker regularly
  // hallucinates on this column) - so a same-rank single-digit substitution
  // there is more plausible than an equally-scored one in Basic/Amount.
  const FIELD_PRIORITY = { quantity: 0, basic: 1, amount: 2 }
  ranked.sort((x, y) => (x.rank - y.rank) || (FIELD_PRIORITY[x.field] - FIELD_PRIORITY[y.field]))

  if (ranked.length >= 2 && ranked[0].rank === ranked[1].rank && ranked[0].field !== 'quantity') return null // still ambiguous
  return ranked[0]
}

// -- RULE C: HSN/SAC junk normalization -------------------------------------------
//
// Strips a stray leading table-border pixel misread as "1" glued onto a real
// 6-digit HSN code, trims trailing OCR noise, and nulls anything that still
// doesn't look like a genuine HSN/SAC (letting applyHsnSacFallback recover it
// from the rest of the table's consensus code instead).
function normalizeHsnSacJunk(hsnSac, warnings, srNo) {
  if (hsnSac === null || hsnSac === undefined) return hsnSac
  const original = String(hsnSac)

  const glued = original.match(/^1(99\d7\d\d)$/)
  if (glued) {
    warnings.push(`HSN/SAC (SR ${srNo ?? 'unknown'}) corrected from "${original}" to "${glued[1]}" - stripped a leading stray digit glued onto the real 6-digit code (deterministic rule).`)
    return glued[1]
  }

  const embedded = original.match(/1?99\d7\d\d/)
  if (embedded) {
    let value = embedded[0]
    if (value.length === 7 && /^1/.test(value)) value = value.slice(1)
    if (value !== original) {
      warnings.push(`HSN/SAC (SR ${srNo ?? 'unknown'}) corrected from "${original}" to "${value}" - trimmed OCR junk around the real code (deterministic rule).`)
    }
    return value
  }

  warnings.push(`HSN/SAC (SR ${srNo ?? 'unknown'}) value "${original}" discarded as unreadable junk (no valid 99_7__-shaped code found) - set to null so the table-consensus fallback can fill it (deterministic rule).`)
  return null
}

function applyHsnJunkRule(items, warnings) {
  return items.map(item => ({ ...item, hsnSac: normalizeHsnSacJunk(item.hsnSac, warnings, item.srNo) }))
}

// A column-shift can also land the HSN/SAC code in the Basic cell (grid path
// mis-detected a column boundary) - a bare 6-digit "99_7__" value with no
// comma/decimal is never a real Basic amount on this template (always
// printed "1,234.00"), so null it out and let the arithmetic/consensus rules
// below fill it back in from Amount - never fabricate, just stop trusting
// a value that's provably not a Basic amount.
function applyBasicHsnLeakRule(items, warnings) {
  return items.map(item => {
    if (typeof item.basic === 'string' && /^99\d7\d\d$/.test(item.basic.trim())) {
      warnings.push(`Row (SR ${item.srNo ?? 'unknown'}) basic "${item.basic}" discarded - it's an HSN/SAC-shaped code, not a Basic amount (column-shift, deterministic rule).`)
      return { ...item, basic: null }
    }
    return item
  })
}

// -- RULE B: row arithmetic repair (basic x quantity = amount) --------------------

function deriveMissingField(basicStr, qtyStr, amountStr, warnings, srNo) {
  const b = parseMoney(basicStr)
  const q = looksCleanInt(qtyStr) ? parseInt(qtyStr.trim(), 10) : null
  const a = parseMoney(amountStr)

  const validCount = [b, q, a].filter(v => v !== null).length
  if (validCount < 2) return { basic: basicStr, quantity: qtyStr, amount: amountStr } // no basis

  if (b !== null && q !== null && a !== null) {
    if (Math.abs(b * q - a) < 0.01) return { basic: basicStr, quantity: qtyStr, amount: amountStr } // consistent, leave alone

    // Try correcting each single field in turn; adopt only if exactly one
    // candidate makes the row exactly consistent AND is OCR-plausible.
    const candidates = []
    const candQ = a / b
    if (Number.isInteger(candQ) && candQ >= 1 && candQ <= 99 && isOcrPlausible(qtyStr, String(candQ))) {
      candidates.push({ field: 'quantity', value: String(candQ) })
    }
    const candB = a / q
    if (candB > 0 && Math.round(candB * 100) === candB * 100 && isOcrPlausible(basicStr, formatMoney(candB))) {
      candidates.push({ field: 'basic', value: formatMoney(candB) })
    }
    const candA = b * q
    if (candA > 0 && isOcrPlausible(amountStr, formatMoney(candA))) {
      candidates.push({ field: 'amount', value: formatMoney(candA) })
    }

    const before = { basic: basicStr, quantity: qtyStr, amount: amountStr }
    const winner = pickBestRowCandidate(candidates, before)
    if (winner) {
      const { field, value } = winner
      warnings.push(`Row (SR ${srNo ?? 'unknown'}) ${field} corrected from "${before[field]}" to "${value}" - basic x quantity = amount arithmetic repair (deterministic rule).`)
      return { ...before, [field]: value }
    }
    return before // ambiguous or no valid correction - leave alone
  }

  // exactly one of the three missing/unparseable, other two valid
  if (b !== null && q !== null && a === null) {
    const cand = b * q
    if (cand > 0) {
      const value = formatMoney(cand)
      warnings.push(`Row (SR ${srNo ?? 'unknown'}) amount filled as "${value}" from basic x quantity (deterministic rule).`)
      return { basic: basicStr, quantity: qtyStr, amount: value }
    }
  } else if (b !== null && a !== null && q === null) {
    const cand = a / b
    if (Number.isInteger(cand) && cand >= 1 && cand <= 99) {
      const value = String(cand)
      warnings.push(`Row (SR ${srNo ?? 'unknown'}) quantity filled as "${value}" from amount / basic (deterministic rule).`)
      return { basic: basicStr, quantity: value, amount: amountStr }
    }
  } else if (q !== null && a !== null && b === null) {
    const cand = a / q
    if (cand > 0 && Math.round(cand * 100) === cand * 100) {
      const value = formatMoney(cand)
      warnings.push(`Row (SR ${srNo ?? 'unknown'}) basic filled as "${value}" from amount / quantity (deterministic rule).`)
      return { basic: value, quantity: qtyStr, amount: amountStr }
    }
  }

  return { basic: basicStr, quantity: qtyStr, amount: amountStr }
}

function applyRowArithmeticRule(items, warnings) {
  return items.map(item => {
    const fixed = deriveMissingField(item.basic, item.quantity, item.amount, warnings, item.srNo)
    return { ...item, ...fixed }
  })
}

// -- RULE D: SR No sequence fill ---------------------------------------------------
//
// Template invariant: line-item SR numbers are consecutive integers starting
// at 2 (row "1" is on the Part-1 page). Fills gaps only when every existing
// clean-integer SR No is consistent with a single offset; falls back to the
// template default (start=2) only when there are zero anchors at all; leaves
// everything untouched if anchors conflict (can't trust any of them).
function applySrNoSequenceRule(items, warnings) {
  if (!Array.isArray(items) || items.length === 0) return items

  const anchors = items
    .map((item, index) => ({ index, value: looksCleanInt(item.srNo) ? parseInt(item.srNo.trim(), 10) : null }))
    .filter(a => a.value !== null)

  let startValue
  if (anchors.length === 0) {
    startValue = 2
  } else {
    const candidateStart = anchors[0].value - anchors[0].index
    const consistent = anchors.every(a => a.value === candidateStart + a.index)
    if (!consistent) return items // conflicting anchors - leave everything untouched
    startValue = candidateStart
  }

  let filledCount = 0
  const result = items.map((item, index) => {
    if (looksCleanInt(item.srNo)) return item
    filledCount++
    return { ...item, srNo: String(startValue + index) }
  })

  if (filledCount > 0) {
    const basis = anchors.length === 0
      ? 'template default (no readable SR No anchors found in this document)'
      : `${anchors.length} readable SR No anchor(s) in this table`
    warnings.push(`SR No filled for ${filledCount} row(s) as a consecutive sequence starting at ${startValue}, based on ${basis} (deterministic rule).`)
  }

  // RULE T6: SR off-by-one. This template's Part-2 table always starts
  // numbering at SR 2 (SR 1 lives on the Part-1 page) - a resulting sequence
  // that is EXACTLY 1..N (consecutive, starting at 1, every row) is itself
  // evidence the whole table got renumbered down by one, so shift every SR
  // No up by 1 to 2..N+1. Only for N >= 2; any other resulting sequence
  // (including a partial/anchor-conflicted one left untouched above) is
  // never touched by this step.
  if (result.length >= 2) {
    const isExactOneToN = result.every((item, index) => looksCleanInt(item.srNo) && parseInt(item.srNo.trim(), 10) === index + 1)
    if (isExactOneToN) {
      warnings.push(`SR No sequence shifted from 1..${result.length} to 2..${result.length + 1} - this template's Part-2 table always starts at SR 2; a full 1..N sequence indicates renumbering (deterministic rule).`)
      return result.map((item, index) => ({ ...item, srNo: String(index + 2) }))
    }
  }

  return result
}

// -- RULE E: description normalization (conservative) ------------------------------

const ITEM_PREFIX_TOKEN = /\b(SC|HOB|GSC|SHANK|STEP ENDMILL|ENDMILL|HOS|HOH|\$C|5C|<C|¢C?)\b/

function normalizeDescriptionText(description) {
  if (typeof description !== 'string' || !description) return description
  let text = description
  let changed = false

  const tokenMatch = text.match(ITEM_PREFIX_TOKEN)
  if (tokenMatch && tokenMatch.index <= 40) {
    if (tokenMatch.index > 0) {
      text = text.slice(tokenMatch.index)
      changed = true
    }
  } else {
    const stripped = text.replace(/^[\s|!'"·—–\-=~_*]+/, '')
    if (stripped !== text) { text = stripped; changed = true }
  }

  // Leading "$C"/"5C"/"<C"/"¢C?" token -> "SC"
  const before1 = text
  text = text.replace(/^(\$C|5C|<C|¢C?)\b/, 'SC')
  if (text !== before1) changed = true

  // "HOH"/"HOS" -> "HOB" only when immediately followed by whitespace+ED/£D
  const before2 = text
  text = text.replace(/\b(HOH|HOS)(?=\s*(ED|£D))/g, 'HOB')
  if (text !== before2) changed = true

  // "£D" -> "ED"
  const before3 = text
  text = text.replace(/£D/g, 'ED')
  if (text !== before3) changed = true

  // "£" -> "E" when directly followed by a digit
  const before4 = text
  text = text.replace(/£(?=\d)/g, 'E')
  if (text !== before4) changed = true

  // RULE T5: standalone "HOR" -> "HOB" when followed by whitespace + ("ED" or
  // "E0"+digits) - same OCR-noise family as the HOH/HOS -> HOB fix above,
  // just a different confused first-letter-pair.
  const beforeT5a = text
  text = text.replace(/\bHOR(?=\s+(ED|E0\d))/g, 'HOB')
  if (text !== beforeT5a) changed = true

  // RULE T5: "E0" -> "ED" when directly followed by 2+ digits (e.g. "E023" ->
  // "ED23"). Conservative - only the letter pair itself is corrected, no
  // attempt to merge/reflow surrounding whitespace.
  const beforeT5b = text
  text = text.replace(/E0(?=\d{2,})/g, 'ED')
  if (text !== beforeT5b) changed = true

  // "@" -> "Ø" when immediately followed by a digit
  const before5 = text
  text = text.replace(/@(?=\d)/g, 'Ø')
  if (text !== before5) changed = true

  // "%" between digit context and degree-like patterns -> "x"
  const before6 = text
  text = text.replace(/x%/g, 'x').replace(/%(?=\d+°)/g, 'x')
  if (text !== before6) changed = true

  return changed ? { text, changed: true } : { text, changed: false }
}

function applyDescriptionNormalizationRule(items, warnings) {
  return items.map(item => {
    const result = normalizeDescriptionText(item.description)
    if (!result || typeof result !== 'object') return item
    if (result.changed) {
      warnings.push(`Description (SR ${item.srNo ?? 'unknown'}) normalized from "${item.description}" to "${result.text}" (deterministic OCR-noise cleanup rule).`)
      return { ...item, description: result.text }
    }
    return item
  })
}

// Single pipeline applying rules C, T4, B, T2, T3, D, E in order (T4 absorbs
// the old unanimity-only HSN fallback into a majority-consensus rule; T2/T3
// need `totals` as a trusted TBA anchor and are skipped silently when totals
// isn't supplied). Called from analyzeDocument on the AI-parsed lineItems
// (passing the already-repaired totals) and from routes/documents.js on the
// grid-extracted items (passing the document's already-repaired totals), so
// both extraction paths get the same repairs. `totals` is optional/backward
// compatible - omitting it just skips the totals-anchored rules.
function normalizePart2LineItems(items, warnings, totals = null) {
  if (!Array.isArray(items) || items.length === 0) return items
  let result = applyHsnJunkRule(items, warnings)
  result = applyBasicHsnLeakRule(result, warnings)
  result = applyHsnMajorityRule(result, warnings)
  result = applyRowArithmeticRule(result, warnings)
  if (totals) {
    result = applyTbaAmountRepair(result, totals, warnings)
    result = applyBasicAnchorAmountFill(result, totals, warnings)
    result = applyQtyOneConsensusRule(result, totals, warnings)
  }
  result = applySrNoSequenceRule(result, warnings)
  result = applyDescriptionNormalizationRule(result, warnings)
  return result
}

// -- RULE A: totals arithmetic repair -----------------------------------------------
//
// Extends applyTotalsSanityRule: when Total Basic Amount and Total Amount are
// both readable and Total Amount > Total Basic Amount, the difference is the
// tax actually charged. On this template tax is always 100% IGST (interstate)
// - so if IGST is missing, or holds the printed RATE "18.00" misread as an
// amount, or disagrees with the arithmetic while CGST/SGST are empty/zero,
// set IGST to the computed difference and zero-fill CGST/SGST.
function repairTotalsArithmetic(totals, warnings) {
  if (!totals) return totals
  const tba = parseMoney(totals.totalBasicAmount)
  const ta = parseMoney(totals.totalAmount)
  if (tba === null || ta === null || ta <= tba) return totals

  const expectedTax = Math.round((ta - tba) * 100) / 100
  const igst = parseMoney(totals.igst)
  const cgst = parseMoney(totals.cgst)
  const sgst = parseMoney(totals.sgst)

  let result = { ...totals }
  let igstRepaired = false

  const igstIsRateMisread = igst === 18 && expectedTax !== 18
  const igstDisagreesWithZeroCgstSgst = igst !== null && Math.abs(igst - expectedTax) > 0.01 && (cgst === null || cgst === 0) && (sgst === null || sgst === 0)

  if (igst === null || igstIsRateMisread || igstDisagreesWithZeroCgstSgst) {
    const value = formatMoney(expectedTax)
    warnings.push(`IGST set to "${value}" (= Total Amount "${totals.totalAmount}" - Total Basic Amount "${totals.totalBasicAmount}") - deterministic totals arithmetic repair${totals.igst ? `, replacing OCR-read "${totals.igst}"` : ''}.`)
    result.igst = value
    igstRepaired = true
  }

  const igstNowMatches = igstRepaired || (igst !== null && Math.abs(igst - expectedTax) <= 0.01)
  if (igstNowMatches) {
    if (result.cgst === null || result.cgst === undefined) {
      result.cgst = '0.00'
      warnings.push('CGST set to "0.00" - tax on this document is fully explained by IGST (interstate template, deterministic rule).')
    }
    if (result.sgst === null || result.sgst === undefined) {
      result.sgst = '0.00'
      warnings.push('SGST set to "0.00" - tax on this document is fully explained by IGST (interstate template, deterministic rule).')
    }
  }

  return result
}

// -- RULE T1: IGST-by-rate repair (runs LAST, strongest anchor) --------------------
//
// The template always prints IGST at a fixed 18% rate, and Total Basic
// Amount (TBA) is the most reliably-read total on the page (large, isolated,
// unambiguous field). repairTotalsArithmetic above derives IGST from
// Total Amount - TBA, which is blind to the case where BOTH totals were
// misread but happen to still agree with each other (internally consistent,
// externally wrong). Anchoring on TBA x 18% catches that case too, so this
// rule runs AFTER repairTotalsArithmetic and wins whenever it disagrees.
// Only fires when TBA itself parses to a positive number - it is the one
// trusted anchor here, never a value derived from IGST/Total Amount.
function repairIgstByRate(totals, warnings) {
  if (!totals) return totals
  const tba = parseMoney(totals.totalBasicAmount)
  if (tba === null) return totals

  const expectedIgst = Math.round(tba * 0.18 * 100) / 100
  const igst = parseMoney(totals.igst)

  let result = { ...totals }

  if (igst === null || Math.abs(igst - expectedIgst) > 0.01) {
    const value = formatMoney(expectedIgst)
    warnings.push(`IGST set to "${value}" (= Total Basic Amount "${totals.totalBasicAmount}" x 18%, the printed IGST rate) - deterministic rate-anchored repair${totals.igst ? `, replacing "${totals.igst}"` : ''}.`)
    result.igst = value
  }

  const expectedTA = Math.round((tba + expectedIgst) * 100) / 100
  const ta = parseMoney(totals.totalAmount)
  if (ta === null || Math.abs(ta - expectedTA) > 0.01) {
    const value = formatMoney(expectedTA)
    warnings.push(`Total Amount set to "${value}" (= Total Basic Amount "${totals.totalBasicAmount}" + IGST "${result.igst}") - deterministic rate-anchored repair${totals.totalAmount ? `, replacing "${totals.totalAmount}"` : ''}.`)
    result.totalAmount = value
  }

  if (result.cgst === null || result.cgst === undefined) result.cgst = '0.00'
  if (result.sgst === null || result.sgst === undefined) result.sgst = '0.00'

  return result
}

// -- RULE T2: TBA-difference row amount repair (needs totals) ----------------------
//
// Total Basic Amount (TBA) is the most reliably-read total on the page, so
// once it's trustworthy it can also confirm/repair individual row Amount
// cells: the row amounts on this template always sum to TBA. Two cases:
// (a) exactly one row's amount is missing - recover it as TBA minus the sum
// of the rest; (b) every row amount parses but the sum doesn't match TBA -
// look for exactly one row whose amount, shifted by the total shortfall,
// becomes "OCR-plausible" (its digit string is a near-match of the
// original's). Ambiguous cases (zero or multiple plausible rows) are left
// untouched rather than guessing which row is wrong.
function reRunRowArithmeticForIndex(items, index, warnings) {
  const item = items[index]
  const fixed = deriveMissingField(item.basic, item.quantity, item.amount, warnings, item.srNo)
  const next = items.slice()
  next[index] = { ...item, ...fixed }
  return next
}

function applyTbaAmountRepair(items, totals, warnings) {
  if (!Array.isArray(items) || items.length === 0 || !totals) return items
  const tba = parseMoney(totals.totalBasicAmount)
  if (tba === null) return items

  const parsedAmounts = items.map(i => parseMoney(i.amount))
  const missingIdx = parsedAmounts.reduce((acc, v, i) => (v === null ? [...acc, i] : acc), [])

  // Case (a): exactly one row missing an amount, all others parse.
  if (missingIdx.length === 1) {
    const idx = missingIdx[0]
    const sumOthers = parsedAmounts.reduce((sum, v, i) => (i === idx ? sum : sum + (v || 0)), 0)
    const missingAmount = Math.round((tba - sumOthers) * 100) / 100
    if (missingAmount > 0) {
      const value = formatMoney(missingAmount)
      warnings.push(`Row (SR ${items[idx].srNo ?? 'unknown'}) amount recovered as "${value}" from Total Basic Amount difference (deterministic rule).`)
      let result = items.slice()
      result[idx] = { ...result[idx], amount: value }
      result = reRunRowArithmeticForIndex(result, idx, warnings)
      return result
    }
    return items
  }

  // Case (b): all amounts parse but the sum disagrees with TBA.
  if (missingIdx.length === 0) {
    const sum = parsedAmounts.reduce((s, v) => s + v, 0)
    const diff = Math.round((tba - sum) * 100) / 100
    if (Math.abs(diff) <= 0.01) return items // already consistent - nothing to repair

    // Classify each row's shifted-by-diff candidate into a plausibility tier
    // against its own original amount string (moneyDigits, decimal stripped):
    // tier 1 - a dropped leading/trailing digit (original is a proper prefix
    // or suffix of the candidate's digit string, e.g. "400" -> "2400");
    // tier 2 - a single substituted digit, same digit-length
    // (editDistanceAtMost1). Anything else is not a candidate at all.
    const candidates = []
    items.forEach((item, i) => {
      const candidate = Math.round((parsedAmounts[i] + diff) * 100) / 100
      if (candidate <= 0) return
      const candidateStr = formatMoney(candidate)
      const o = moneyDigits(item.amount)
      const c = moneyDigits(candidateStr)
      if (!o || !c || o === c) return
      let tier = null
      if (c.length > o.length && (c.startsWith(o) || c.endsWith(o))) tier = 1
      else if (o.length > c.length && (o.startsWith(c) || o.endsWith(c))) tier = 1
      else if (o.length === c.length && editDistanceAtMost1(o, c)) tier = 2
      if (tier !== null) candidates.push({ index: i, value: candidateStr, tier })
    })

    let winner = null
    if (candidates.length === 1) {
      winner = candidates[0]
    } else if (candidates.length > 1) {
      const lowestTier = Math.min(...candidates.map(c => c.tier))
      const topTier = candidates.filter(c => c.tier === lowestTier)
      if (topTier.length === 1) {
        winner = topTier[0]
      } else {
        // Still tied - keep only candidates whose correction ACHIEVES row
        // consistency (basic x quantity === amount, integer quantity) where
        // the row was NOT already consistent before the change. A candidate
        // that would break an already-consistent row is never the real fix.
        const consistent = topTier.filter(cand => {
          const item = items[cand.index]
          const before = checkRowConsistency(item.basic, item.quantity, item.amount)
          const after = checkRowConsistency(item.basic, item.quantity, cand.value)
          return !before && after
        })
        if (consistent.length === 1) winner = consistent[0]
      }
    }

    if (winner) {
      const { index, value } = winner
      warnings.push(`Row (SR ${items[index].srNo ?? 'unknown'}) amount corrected from "${items[index].amount}" to "${value}" - Total Basic Amount difference repair (deterministic rule).`)
      let result = items.slice()
      result[index] = { ...result[index], amount: value }
      result = reRunRowArithmeticForIndex(result, index, warnings)
      return result
    }
    return items // zero or still-ambiguous candidates - leave alone
  }

  return items // more than one row missing an amount - not enough basis
}

// True when basic x quantity === amount, i.e. the row is internally
// arithmetic-consistent - used only to compare before/after a candidate
// correction, never to decide anything on its own. When quantity is missing
// (not a printed clean integer), it's treated as derivable: consistency
// holds if amount/basic itself resolves to a clean integer 1-99 (the same
// thing rule B would derive), since a missing quantity is not itself
// evidence of inconsistency - only an unresolvable one is.
function checkRowConsistency(basic, quantity, amount) {
  const b = parseMoney(basic)
  const a = parseMoney(amount)
  if (b === null || a === null) return false
  if (looksCleanInt(quantity)) {
    const q = parseInt(String(quantity).trim(), 10)
    return Math.abs(b * q - a) < 0.01
  }
  const derivedQ = a / b
  return Number.isInteger(derivedQ) && derivedQ >= 1 && derivedQ <= 99
}

// -- RULE T3b: basic-anchored amount fill (needs totals) ---------------------------
//
// Companion to T3 below, for the opposite gap shape: Basic is present but
// Amount (and Quantity) are missing. Only fires when every readable Quantity
// on the document is 1 AND a tentative fill (Amount = Basic wherever Amount
// is missing) makes every row amount sum to Total Basic Amount - that sum
// match is the proof that Quantity really is 1 on the missing rows too and
// that Basic really does equal Amount there, not a guess.
function applyBasicAnchorAmountFill(items, totals, warnings) {
  if (!Array.isArray(items) || items.length === 0 || !totals) return items
  const tba = parseMoney(totals.totalBasicAmount)
  if (tba === null) return items

  const readableQtys = items.map(i => (looksCleanInt(i.quantity) ? parseInt(i.quantity.trim(), 10) : null)).filter(v => v !== null)
  if (readableQtys.length === 0 || !readableQtys.every(v => v === 1)) return items

  const fillIdx = []
  items.forEach((item, i) => {
    const hasAmount = parseMoney(item.amount) !== null
    const hasBasic = parseMoney(item.basic) !== null
    if (!hasAmount && hasBasic) fillIdx.push(i)
  })
  if (fillIdx.length === 0) return items

  const tentative = items.map(item => {
    const a = parseMoney(item.amount)
    return a !== null ? a : parseMoney(item.basic)
  })
  if (tentative.some(v => v === null)) return items // some row has neither - no basis
  const sumTentative = tentative.reduce((s, v) => s + v, 0)
  if (Math.abs(sumTentative - tba) > 0.01) return items // guard: consensus not proven

  const result = items.slice()
  for (const idx of fillIdx) {
    const value = formatMoney(parseMoney(result[idx].basic))
    warnings.push(`Row (SR ${result[idx].srNo ?? 'unknown'}) amount filled as "${value}" and quantity as "1" - Basic column sums to Total Basic Amount and every readable Quantity is 1 (deterministic consensus rule).`)
    result[idx] = {
      ...result[idx],
      amount: value,
      quantity: looksCleanInt(result[idx].quantity) ? result[idx].quantity : '1',
    }
  }
  return result
}

// -- RULE T3: qty=1 consensus fill (needs totals) -----------------------------------
//
// Fires only once the row-amount column is PROVEN correct (every amount
// parses and the row amounts already sum to TBA), and every readable
// Quantity in the document reads as exactly 1 - on this template that means
// this document's whole table is single-quantity rows, so a row missing
// both Basic and Quantity can be safely filled: Basic = Amount (since
// Basic x 1 = Amount) and Quantity = "1". Independent of that consensus,
// also handles the narrower case where Basic and Amount already read
// identically and Quantity is the only gap - itself strong evidence
// Quantity = 1 for that row alone.
function applyQtyOneConsensusRule(items, totals, warnings) {
  if (!Array.isArray(items) || items.length === 0) return items
  let result = items

  // Narrow sub-case: basic == amount (both parse) and quantity missing.
  result = result.map(item => {
    if (looksCleanInt(item.quantity)) return item
    const b = parseMoney(item.basic)
    const a = parseMoney(item.amount)
    if (b !== null && a !== null && Math.abs(b - a) < 0.01) {
      warnings.push(`Row (SR ${item.srNo ?? 'unknown'}) quantity filled as "1" - Basic and Amount read identically, which is only possible when Quantity = 1 (deterministic rule).`)
      return { ...item, quantity: '1' }
    }
    return item
  })

  // Consensus sub-case: needs proven-correct amount column against TBA.
  if (!totals) return result
  const tba = parseMoney(totals.totalBasicAmount)
  if (tba === null) return result

  const parsedAmounts = result.map(i => parseMoney(i.amount))
  if (parsedAmounts.some(v => v === null)) return result
  const sum = parsedAmounts.reduce((s, v) => s + v, 0)
  if (Math.abs(sum - tba) > 0.01) return result // amount column not proven correct

  const readableQtys = result.map(i => (looksCleanInt(i.quantity) ? parseInt(i.quantity.trim(), 10) : null)).filter(v => v !== null)
  if (readableQtys.length === 0 || !readableQtys.every(v => v === 1)) return result

  return result.map(item => {
    const hasBasic = parseMoney(item.basic) !== null
    const hasQty = looksCleanInt(item.quantity)
    const hasAmount = parseMoney(item.amount) !== null
    if (hasBasic || hasQty || !hasAmount) return item
    warnings.push(`Row (SR ${item.srNo ?? 'unknown'}) row total proven by Total Basic Amount; every readable Quantity on this document is 1 - filled Basic=Amount, Quantity=1 (deterministic consensus rule).`)
    return { ...item, basic: formatMoney(parseMoney(item.amount)), quantity: '1' }
  })
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

  // Totals repair runs BEFORE line-item rules so TBA/IGST are already sane by
  // the time T2/T3 use TBA as an anchor. T1 (repairIgstByRate) runs last in
  // this chain since it's the strongest/most reliable anchor (fixed 18% rate
  // off Total Basic Amount) and should win over the weaker TA-derived repair.
  part2Parsed.totals = repairIgstByRate(
    repairTotalsArithmetic(applyTotalsSanityRule(part2Parsed.totals, warnings), warnings),
    warnings
  )

  part2Parsed.lineItems = normalizePart2LineItems(
    mergeDuplicateDescriptionRows(cleanLineItemNumbers(sanitizeLineItems(part2Parsed.lineItems, warnings)), warnings),
    warnings,
    part2Parsed.totals
  )

  // Header metadata usually comes from Part 1, but the automatic page split can
  // occasionally place a line or two on the Part 2 side - fall back to Part 2's
  // safety-net capture of the same fields when Part 1 didn't find them.
  const pick = (key) => part1Parsed[key] ?? part2Parsed[key] ?? null

  let consignee = applyConsigneeAddressRule(part1Parsed.consignee || null, warnings)
  let consignor = applyConsignorAddressRule(part1Parsed.consignor || null, part1Text, warnings)
  consignee = repairGstin(consignee, 'Consignee', warnings)
  consignor = repairGstin(consignor, 'Consignor', warnings)

  const rescuedFiDoc = applyFiDocRescueRule(applyFiDocGuard(pick('fiDoc'), warnings), pick('irnNo'), part1Text, warnings)

  const part1Like = {
    consignee,
    consignor,
    invoiceNo: pick('invoiceNo'),
    fiDoc: rescuedFiDoc.fiDoc,
    challanDate: pick('challanDate'),
    reason: applyReasonSubtitleRule(pick('reason'), part1Text, warnings),
    poNo: applyPoNoRule(pick('poNo'), part1Text, warnings),
    requestNo: pick('requestNo'),
    irnNo: rescuedFiDoc.irnNo,
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
  normalizePart2LineItems,
  repairTotalsArithmetic,
  repairIgstByRate,
}
