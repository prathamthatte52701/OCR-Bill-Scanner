# ChallanIntel AI

**AI-powered extraction, verification, and Q&A for Consignor–Consignee delivery challans** (Rule 55 of CGST Rule documents). Upload a delivery challan as one photo (auto-split) or as two cropped photos (header + line-items); the system runs OCR, extracts every field with an AI model, repairs known OCR error patterns with deterministic rules, lets you correct anything by hand, and lets you ask questions about the document in plain English.

This is a **single, fixed-template extraction pipeline** — tuned specifically for the "Delivery Challan under Rule 55 of CGST Rule" layout used by VE Commercial Vehicles / Oerlikon Balzers (a Consignee/Consignor header table + an "UNCODED RGP" line-items table). It is not a general-purpose document parser; almost all of its accuracy comes from knowing this exact template cold.

---

## Table of Contents

- [Features](#features)
- [High-Level Flow](#high-level-flow)
- [Architecture Overview](#architecture-overview)
- [The Extraction Pipeline, Step by Step](#the-extraction-pipeline-step-by-step)
- [Part 1 — Deterministic Repair Rules](#part-1--deterministic-repair-rules)
- [Part 2 — The OpenCV Grid Pivot](#part-2--the-opencv-grid-pivot)
- [Part 2 — Deterministic Repair Rules](#part-2--deterministic-repair-rules)
- [Data Model](#data-model)
- [Editing & Data Integrity](#editing--data-integrity)
- [Chat Interface](#chat-interface)
- [API Reference](#api-reference)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup & Run](#setup--run)
- [Environment Variables](#environment-variables)
- [Reliability & Failure Handling](#reliability--failure-handling)
- [Known Limitations](#known-limitations)
- [Roadmap Ideas](#roadmap-ideas-not-built)

---

## Features

- **Two upload modes**
  - *Single-image auto-split* — upload one photo/PDF; the system finds the "UNCODED RGP" divider and splits it into Part 1 (header) and Part 2 (line-items) itself.
  - *Two-image upload* — upload two separately-cropped photos (Part 1 header + Part 2 line-items table). Manually cropping each half gives Tesseract a bigger, cleaner target and measurably higher accuracy on hard photos, so this is the preferred path for phone shots.
- **Independent per-part OCR + AI extraction** — header and line-items are OCR'd and sent to the AI in two parallel calls, each with its own strict, template-specific prompt.
- **OpenCV grid pivot for line items** — a Python/OpenCV pass detects the printed table's actual cell grid (deskews the photo first, isolates the table's own bordered rectangle so footer/stamp boxes don't pollute it), and each cell is OCR'd in isolation so values can't bleed across columns. This result is adopted only when it strictly beats the AI-text result.
- **Deterministic "never-regress" repair rules** — a large layer of pure functions repairs recurring, well-understood OCR error patterns without ever inventing data:
  - Part 1: GSTIN checksum reconstruction, reason-subtitle blacklist, FI Doc rescue, consignee/consignor address normalization, PO No pattern capture.
  - Part 2: row arithmetic (`basic × qty = amount`), tax-totals arithmetic (`IGST = TBA × 18%`), HSN/SAC junk cleanup + majority vote, SR No sequence fill, description character normalization, column-shift guards.
- **Every field editable, single source of truth** — an edit overwrites the value everywhere (document, tables, summary, chat context) via one regeneration path. No parallel "AI value vs corrected value."
- **Two-page chat interface** — focused Part 1 / Part 2 chat views with grouped-detail buttons and free-form Q&A answered only from the document's extracted data.
- **Add / edit line items** — rows can be added or corrected after extraction through the API.
- **Warnings surfaced, never silent** — every automatic correction, partial read, or uncertainty is logged to the document's `warnings[]` and shown to the user.

---

## High-Level Flow

```
        Upload (1 photo/PDF  OR  2 cropped photos)
                        │
                        ▼
        ┌───────────────────────────────┐
        │  Resolve OCR input             │
        │  digital PDF → text layer      │
        │  scanned PDF → rasterize pg 1  │
        │  image       → straight in     │
        └───────────────┬───────────────┘
                        ▼
        ┌───────────────────────────────┐
        │  Preprocess + Tesseract OCR    │   (isolated child process)
        │  Part 1 crop  |  Part 2 crop   │
        └───────┬───────────────┬────────┘
                ▼               ▼
        ┌────────────┐   ┌──────────────────────────────┐
        │ Groq AI    │   │ Groq AI (Part 2 text)         │
        │ (Part 1)   │   │        +                       │
        │            │   │ OpenCV grid pivot (Part 2)     │
        └─────┬──────┘   └──────────────┬────────────────┘
              ▼                          ▼
        ┌──────────────┐        ┌──────────────────────────┐
        │ Part 1        │        │ Part 2: pick grid vs AI   │
        │ deterministic │        │ result, then deterministic│
        │ repair rules  │        │ repair rules              │
        └──────┬───────┘        └────────────┬─────────────┘
               └────────────┬────────────────┘
                            ▼
              assembleDocumentViews()  ← one function builds every UI surface
                            ▼
                  MongoDB  +  Frontend (Part 1 / Part 2 tabs, chat, edit)
```

---

## Architecture Overview

```
┌─────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│   Frontend   │◄────►│   Express Backend    │◄────►│   MongoDB Atlas  │
│  React+Vite  │ HTTP │   (routes/services)  │      │  (+ GridFS files)│
└─────────────┘      └──────────┬───────────┘      └─────────────────┘
                                 │
        ┌────────────────────────┼───────────────────────────┐
        ▼                        ▼                            ▼
┌─────────────────────┐ ┌───────────────────────┐  ┌──────────────────────┐
│ ocr-worker.js        │ │ pdf-render-worker.js   │  │ table-grid.py         │
│ (isolated child proc)│ │ (isolated child proc)  │  │ (Python/OpenCV,        │
│ Tesseract.js OCR     │ │ pdfjs-dist + canvas    │  │  spawned per request)  │
└─────────────────────┘ └───────────────────────┘  └──────────────────────┘
        │                                                     │
        ▼                                                     ▼
┌─────────────────────┐                          ┌──────────────────────┐
│      Groq API        │  <- round-robin over N   │ grid-line-items.js    │
│  Llama 3.3 70B        │     keys, auto-failover  │ (per-cell tesseract)  │
└─────────────────────┘                          └──────────────────────┘
```

**Why child processes for OCR, PDF, and the grid pass:** Tesseract, PDF rasterization, and OpenCV are the heaviest, least-predictable operations in the pipeline (a malformed image or hostile PDF can hang or crash a native library). Each runs in a dedicated, timeout-bounded process spawned per request — the main Express process never performs them directly and can't be taken down by a bad upload.

---

## The Extraction Pipeline, Step by Step

1. **Upload** — `POST /api/documents/upload` (single image, auto-split) or `POST /api/documents/upload-parts` (two cropped images). File(s) validated (magic-byte MIME sniffing, size, PDF page count), stored in GridFS, queued for background processing (one job at a time to avoid OOM on constrained hosts).
2. **OCR input resolution**:
   - **Digital PDF** (real text layer) → text extracted directly via `pdf-parse`, no OCR.
   - **Scanned PDF** (no text layer) → page 1 rasterized to PNG in an isolated child process, then into the image pipeline. Multi-page scanned PDFs process page 1 only, with a warning (one bill per upload).
   - **JPG/PNG** → straight into the image pipeline.
3. **Image preprocessing** (`ocr-worker.js`) — upscaled with Lanczos3 (**4x** for Part 1, **3.5x** for Part 2 — tuned separately from measured confidence at 2x/3x/4x/5x/raw on real samples), converted to grayscale. Multiple strategies are tried (grayscale, sharpened, binarized, table-band) and the best-scoring result wins.
4. **Auto page split** (single-image mode only) — the page is split by locating the printed "UNCODED RGP" divider using Tesseract word-level bounding boxes (tolerant of page-to-page size variation), with a fixed-ratio fallback. In two-image mode this step is skipped — each uploaded crop is already one part.
5. **Independent OCR per part** — each crop is OCR'd with multiple Tesseract strategies. Part 2's result is validated against a real table-content check (a 6-digit HSN/SAC code present, not just a stray keyword); if only the tax footer seems captured, the split/strategy is retried.
6. **Independent AI extraction per part** — Part 1 text and Part 2 text go to Groq (Llama 3.3 70B) in **two parallel calls**, each with its own strict system prompt. Each call round-robins to a different key from the pool.
7. **Part 2 grid pivot** — in parallel with the AI call, the Part 2 image goes through the OpenCV grid pass (see below). The grid result replaces the AI-text line items only if it produces **strictly more rows**.
8. **Deterministic repair rules** — Part 1 and Part 2 each run through their own chain of pure repair functions (see the two sections below).
9. **Garbage-row filtering** — any line item without a genuinely readable description (a stray footer number misattributed to a fake row) is dropped, with a warning.
10. **View assembly** — `assembleDocumentViews` turns the canonical data into every display surface (flat editable fields, Parties/Line Items/Totals tables, full-text summary, Part 1 / Part 2 breakdowns). Reused after every correction, so there's exactly one code path producing what the UI shows.

---

## Part 1 — Deterministic Repair Rules

All run after the AI parse, in `services/groq.js`. Each pushes a warning on every correction and never fabricates a value with zero OCR basis.

| Rule | What it fixes |
|---|---|
| **GSTIN checksum reconstruction** (`repairGstin`) | Rebuilds a 15-char GSTIN from the reliably-read State Code + PAN using the official base-36 checksum algorithm, and adopts it only if it scores a high positional match against what OCR actually read. Fixes the single most common Part 1 error (garbled/truncated GSTIN trailing chars). |
| **Reason subtitle blacklist** (`applyReasonSubtitleRule`) | The page's boilerplate subtitle ("Transportation of goods for reasons other than by way of supply") is sometimes read into the Reason field; this detects it and recovers the real value from the raw OCR "UNIT-xx" line, else honest `null`. |
| **FI Doc rescue** (`applyFiDocRescueRule`, `applyFiDocGuard`) | Regex fallback for the fixed `1015xxxxxx` pattern; also detects a FI Doc value that landed in the wrong field (irnNo) and moves it back; guards against non-digit garbage. |
| **Consignee address rule** (`applyConsigneeAddressRule`) | Fixed per detected State: Gujarat → `AHMEDABAD 382220`, Maharashtra → `PUNE 411026`. Unknown state leaves OCR value untouched + warns. |
| **Consignor address rule** (`applyConsignorAddressRule`) | Fixed by detecting the `87A`/`78-86` prefix in the **raw OCR text** (not the AI's own possibly-hallucinated output): the one canonical Dewas address. |
| **PO No rule** (`applyPoNoRule`) | Safety-net capture of the fixed `3242xxxxxx` PO number pattern from raw text. |

---

## Part 2 — The OpenCV Grid Pivot

Passing the whole line-items table into Tesseract in one shot lets text bleed across columns and rows (a Quantity value landing in Amount, etc.). The grid pivot avoids that by detecting the table's real printed cell structure and OCR-ing each cell alone.

**`services/table-grid.py`** (Python/OpenCV, spawned per request):
1. Upscale 3.5x, grayscale, adaptive-threshold (handles uneven phone-photo lighting a global threshold can't).
2. Morphological opening with long thin horizontal/vertical kernels to isolate real border lines from text noise.
3. **Deskew** — `HoughLinesP` estimates the page tilt (phone photos are rarely level; even 1–2° misaligns every cell), then `warpAffine` rotates it straight before any grid detection.
4. **Table-region isolation** — the largest wider-than-tall bordered rectangle near the top of the page is taken as the line-items table, so the CGST/SGST/IGST totals box, stamp box, and Tel/Fax footer boxes lower down don't get scanned as extra table rows (critical for short 1–2 row tables). Falls back to full-image scanning if no rectangle qualifies.
5. **Line-position projection** derives row/column boundaries; missing outer border lines at the image/table edge are back-filled.
6. Writes the deskewed image + a JSON grid of `{x,y,w,h}` cell boxes.

**`services/grid-line-items.js`** (Node bridge):
- Finds a Python interpreter, runs the script, reads the grid JSON + deskewed image.
- OCRs each cell with tesseract.js; SR No and Quantity (narrow columns) get a second digit-only OCR pass (tighter crop, extra upscale, `psm 8`, digit whitelist) because the prose worker hallucinates on them.
- Splits a merged "SR No + Description" cell when the internal divider is faint.
- Filters header/footer rows; stops at the "Total Basic Amount" row so declaration/stamp text below never leaks in.
- **Column-shift guard**: if the majority of rows have an HSN-shaped value sitting in the Quantity column, the grid mis-detected its boundaries → returns `null` and the caller falls back to the standard AI-text result rather than surfacing garbage.
- On any failure (no Python, no usable grid) returns `null` → standard path used. **Never worse than before.**

The route adopts the grid result only when `gridRows > standardRows`, so a previously-correct document can never be made worse by the pivot.

---

## Part 2 — Deterministic Repair Rules

Applied to both extraction paths (`normalizePart2LineItems`), pushing a warning per correction, never fabricating.

| Rule | What it fixes |
|---|---|
| **HSN/SAC junk normalization** (`applyHsnJunkRule`) | Strips a leading border-pixel digit (`1993729` → `993729`), nulls non-HSN garbage so the majority rule can refill it. |
| **HSN majority vote** (`applyHsnMajorityRule`, `applyHsnSacFallback`) | Every row on one document shares one HSN code; minority-misread codes (differing by ≤1–2 chars) are corrected to the majority. |
| **Basic-HSN-leak guard** (`applyBasicHsnLeakRule`) | A bare 6-digit `99_7__` in the Basic cell is an HSN code that shifted columns, never a real amount — nulled so arithmetic/consensus rules refill it. |
| **Row arithmetic repair** (`applyRowArithmeticRule`) | `basic × quantity = amount` is a template invariant; when one of the three is missing or inconsistent, it's derived from the other two (with an OCR-plausibility check before adopting). |
| **Totals arithmetic** (`repairTotalsArithmetic`, `repairIgstByRate`) | On this interstate template tax is 100% IGST at 18%. `IGST = Total Basic Amount × 18%` and `Total Amount = TBA + IGST` are recomputed from the reliably-read TBA anchor; CGST/SGST zero-filled. |
| **TBA-difference amount repair** (`applyTbaAmountRepair`) | Row amounts sum to TBA; when they don't, the single row whose OCR-plausible correction closes the gap is fixed. Ambiguous multi-candidate cases are tiered (dropped-digit > substitution) and, on a remaining tie, prefer the correction that resolves the row's own arithmetic — otherwise left untouched, never guessed. |
| **Basic-anchor amount fill** (`applyBasicAnchorAmountFill`) | When Amount/Quantity are missing but Basic is present and every readable Quantity is 1 and a tentative `Amount=Basic` fill makes rows sum to TBA (the proof), fills Amount=Basic, Quantity=1. |
| **Quantity=1 consensus** (`applyQtyOneConsensusRule`) | When the amount column is proven correct against TBA and every readable Quantity is 1, fills gaps as Basic=Amount, Quantity=1. |
| **SR No sequence fill** (`applySrNoSequenceRule`) | Fills missing SR numbers from a consistent anchor and corrects a whole-table off-by-one (this template's Part 2 table always starts at SR 2). |
| **Description normalization** (`applyDescriptionNormalizationRule`) | Fixes recurring OCR substitutions (`Ø` read as `@`, `HOB` read as `HOR`/`HOS`, `£D`→`ED`, `$C`/`5C`→`SC`, leading border-line junk). |
| **Totals sanity** (`applyTotalsSanityRule`) | Interstate-only guard: if exactly one of CGST/SGST/IGST is nonzero and it isn't IGST, moves it to IGST and zeroes the rest. |

**Design principle across every rule:** an honest `null` beats a confident wrong answer. Rules only correct values with a clear, OCR-plausible basis; when the evidence is genuinely ambiguous, they leave the value untouched rather than guess.

---

## Data Model

Each `Document` stores:

| Field | Description |
|---|---|
| `consignee`, `consignor` | Structured party objects (code, name, address, state, GSTIN, PAN) |
| `invoiceNo`, `fiDoc`, `challanDate`, `reason`, `poNo`, `requestNo`, `irnNo` | Header metadata scalars |
| `lineItems[]` | One entry per printed row (SR No, description, HSN/SAC, basic, quantity, amount) |
| `totals` | Total Basic Amount, CGST, SGST, IGST, Total Amount |
| `extractedFields[]` | Every value above, flattened into `{label, normalizedKey, value, edited, category}` — what the Edit UI operates on |
| `extractedTables[]` | Parties / Line Items / Totals, pre-built for table display |
| `fullSummary`, `summaryPoints[]` | Human-readable summary text/bullets |
| `part1`, `part2` | Per-part fields/tables/summary, for the Part 1 / Part 2 chat pages |
| `editedFieldKeys[]` | Which `normalizedKey`s have been manually corrected (drives the "(edited)" badge) |
| `warnings[]` | Every extraction uncertainty, partial read, or deterministic-rule override |

All of the above (except the raw hidden OCR text) are derived from one canonical source and regenerated together.

---

## Editing & Data Integrity

**No hallucination, but no silent data loss either.** `null` means *the OCR text contains nothing for this field*. If OCR found *some* real characters but not the complete value, the AI returns that partial fragment (flagged in warnings) rather than nulling it "to be safe" — and never pads a partial value out to look complete, and never invents a character correction where no real misread exists.

**Single source of truth for corrections.** Editing a field doesn't create a parallel "corrected value" that display code must remember to check. `PATCH /api/documents/:id/fields/:fieldKey/correct` writes the new value directly into the canonical structured data and then calls the same `assembleDocumentViews` used after extraction to regenerate *every* derived view. The old value doesn't linger anywhere — not in a table row, not in the summary, not in a stale Part 1/Part 2 snapshot.

**Deterministic rules are logged, not silent.** Every address normalization, GSTIN reconstruction, arithmetic repair, etc. is applied as plain code (never AI guessing) and pushed to `warnings[]`, so an automatic correction is never a surprise.

---

## Chat Interface

Two focused chat pages instead of one page mixing both parts:

- **`/documents/:id/chat/part1`** — Consignee Details, Consigner Details, About, Full Summary
- **`/documents/:id/chat/part2`** — Taxes, Uncoded RGP, About, Full Summary

Clicking a button appends a result to the chat history (doesn't replace the previous one — scroll up through everything). Every button renders live from current document state, so an edit anywhere reflects in every previously-opened view. Free-form questions are answered by Groq using only the document's extracted fields/tables/summary (never general knowledge), with a 50-message document-scoped history.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/documents/upload` | Upload one image/PDF, auto-split into Part 1 / Part 2 |
| `POST` | `/api/documents/upload-parts` | Upload two cropped images (Part 1 header + Part 2 line-items) |
| `GET` | `/api/documents` | List all documents |
| `GET` | `/api/documents/:id` | Get one document |
| `GET` | `/api/documents/:id/download` | Download the original uploaded file |
| `GET` | `/api/documents/:id/download/:part` | Download a specific part image (`part1`/`part2`) |
| `POST` | `/api/documents/:id/reprocess` | Re-run OCR + AI extraction |
| `POST` | `/api/documents/:id/line-items` | Add a line-item row |
| `DELETE` | `/api/documents/:id` | Soft-delete a document |
| `PATCH` | `/api/documents/:id/fields/:fieldKey/correct` | Correct a field (overwrites everywhere) |
| `GET` | `/api/documents/:id/chat` | Get chat history |
| `POST` | `/api/documents/:id/chat` | Send a chat message |
| `POST` | `/api/documents/:id/chat/:messageId/feedback` | Rate a chat response (1-10) |
| `GET` | `/api/documents/training-stats` | Count of processed/corrected documents |
| `GET` | `/api/documents/feedback-stats` | Chat rating analytics |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite, Tailwind CSS, React Router |
| Backend | Node.js, Express |
| Database | MongoDB + Mongoose |
| File storage | MongoDB GridFS |
| OCR | Tesseract.js (isolated child process) |
| Image processing | Sharp (upscale, grayscale, threshold, crop) |
| Table/grid detection | Python + OpenCV (`cv2`) — deskew, adaptive threshold, morphological line detection, cell-grid extraction (spawned per request) |
| PDF rendering | pdfjs-dist + @napi-rs/canvas (isolated child process), pdf-parse for digital-text PDFs |
| AI extraction & chat | Groq (Llama 3.3 70B) via `groq-sdk`, round-robin across a configurable pool of API keys with automatic failover |

---

## Project Structure

```
OCR project AJ/
├── frontend/                    # React + Vite app
│   └── src/
│       ├── components/          # Chat, tables, correction modal, add-row modal, detail views
│       ├── pages/                # Dashboard, Upload, Documents, Detail, Part1/Part2 Chat
│       └── utils/                 # API client
├── backend/
│   ├── models/                  # Document, Correction, ChatMessage, ChatFeedback
│   ├── routes/                  # documents.js (upload, parts, correct, line-items), chat.js
│   └── services/
│       ├── ocr.js                # Orchestrates OCR/PDF pipeline, spawns child processes
│       ├── ocr-worker.js         # Child process: upscale (4x P1 / 3.5x P2), split, Tesseract
│       ├── pdf-render-worker.js  # Child process: scanned-PDF page-1 rasterization
│       ├── table-grid.py         # Python/OpenCV: deskew + table-region + cell-grid detection
│       ├── grid-line-items.js    # Node bridge: per-cell OCR of the grid, Part 2 only
│       ├── groq.js               # AI prompts, extraction, all repair rules, view assembly
│       └── gridfs.js             # File storage
└── README.md
```

---

## Setup & Run

### Prerequisites

- Node.js
- **Python 3 with OpenCV** (`pip install opencv-python numpy`) — required for the Part 2 grid pivot. Without it, the grid pass is skipped and the pipeline falls back to AI-text line-item extraction (degraded, not broken).

### 1. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
pip install opencv-python numpy
```

### 2. Configure environment

Copy `backend/.env.example` to `backend/.env` and fill in your values (see below).

### 3. Run backend

```bash
cd backend
npm run dev
# http://localhost:5002
```

### 4. Run frontend

```bash
cd frontend
npm run dev
# http://localhost:5174
```

---

## Environment Variables

Create `backend/.env`:

```env
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/docintel_transport?appName=Cluster0
GROQ_API_KEYS=gsk_key1,gsk_key2,gsk_key3
PORT=5002
NODE_ENV=development
```

- `GROQ_API_KEYS` accepts a **comma-separated list** of keys (any number). Each AI call round-robins to the next key and automatically fails over on a rate-limit, auth, or server error — a single exhausted/invalid key never stalls processing. `GROQ_API_KEY` (singular) is still supported as a one-key fallback. (Groq's free tier has a per-day token cap per key, so a pool of keys materially raises daily throughput.)

---

## Reliability & Failure Handling

- **Round-robin + failover**: every Groq call picks its own fixed starting key index (advanced synchronously before any await), then walks the entire pool once from there if needed. Because Part 1 and Part 2 extraction run in parallel and each reserves a starting index up front, they use different keys under normal conditions and neither can get stuck retrying a key the other already proved bad.
- **Isolated OCR / PDF / grid processing**: a malformed image, corrupt PDF, or failing OpenCV pass can only ever fail its own child process — the main server and other in-flight requests are unaffected. The grid pass returning `null` transparently falls back to the AI-text path.
- **Grid pivot is strictly non-regressing**: adopted only when it produces more rows than the standard path; column-shift and Python-missing cases both fall back safely.
- **Serialized processing queue**: one OCR/AI job at a time server-side, to avoid memory pressure from concurrent Tesseract/OpenCV workers on constrained hosts.
- **Filename integrity**: the document's display name is derived directly from the uploaded file's original name — never invented or renumbered.

---

## Known Limitations

- **Fixed-template pipeline** (VE Commercial Vehicles / Oerlikon Balzers "Delivery Challan under Rule 55 of CGST Rule"). Not a general-purpose extractor; the deterministic rules are specific to this template's known values and invariants.
- **Source photo quality is the hard floor.** Low-contrast prints (e.g. some MG-series item templates) or heavily skewed/blurred photos can produce OCR text that's garbage before any rule runs — deterministic rules can only repair what OCR actually read, not recover text that never made it out of Tesseract. These cases need a better source photo or a paid OCR engine (e.g. AWS Textract table detection), not more post-processing.
- **Genuinely ambiguous multi-error rows are left as honest gaps**, not guessed, when two fields on a row are wrong in the same OCR-noise pattern and no unique correction is provable.
- **Scanned PDFs**: page 1 only (surfaced as a warning) — the data model assumes one bill per upload.
- **No authentication** — single-user / local workflow.
- **Processing takes ~15–70 s per document** depending on OCR fallback depth, grid pass, and Groq latency (plus retry time when free-tier keys are rate-limited).

---

## Roadmap Ideas (Not Built)

- Paid OCR engine (AWS Textract / Google Document AI table detection) for the low-contrast and single-row photos that the current OCR can't read — the main remaining accuracy ceiling.
- CLAHE / adaptive contrast enhancement in the grid pass to rescue low-contrast (MG-series) documents.
- Admin dashboard, multi-user auth, role-based access.
- Export to Excel/PDF.
- Batch upload and multi-document comparison.
- Native mobile app.
