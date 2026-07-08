# DocIntel - Business Document Intelligence (Version 1)

A focused web app for uploading, extracting, and chatting with business documents.  
Upload one document at a time, get structured AI-extracted data, and ask questions in plain English.

---

## Version 1 Scope

- Upload JPG, JPEG, PNG, or PDF (max 5 MB, PDF max 4 pages)
- Free OCR text extraction (Tesseract.js for images, pdf-parse for PDFs)
- Groq AI extraction: structured fields, tables, document summary
- Document-specific chat/Q&A (answers only from uploaded document)
- Field correction (fix any extracted value)
- Reprocess documents (re-run OCR + AI)
- Download original uploaded file
- Soft delete documents
- Document history with status tracking
- Mobile-responsive dark mode UI

---

## Tech Stack

| Layer     | Technology                                      |
|-----------|-------------------------------------------------|
| Frontend  | React + Vite, Tailwind CSS v4, React Router     |
| Backend   | Node.js, Express 5                              |
| Database  | MongoDB + Mongoose                              |
| Storage   | MongoDB GridFS (file storage)                   |
| OCR       | Tesseract.js (images), pdf-parse (PDFs)         |
| AI        | Groq Llama 3.3 70B via `groq-sdk`                  |

---

## Project Structure

```
OCR project AJ/
|-- frontend/          # React + Vite app
|   -- src/
|       |-- components/   # Reusable UI components
|       |-- pages/        # Route-level pages
|       -- utils/        # API helper
|-- backend/           # Express API server
|   |-- models/        # Mongoose schemas
|   |-- routes/        # API route handlers
|   -- services/      # OCR, Groq AI, GridFS
-- README.md
```

---

## Environment Variables

Create `backend/.env`:

```env
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/docintel
GROQ_API_KEY=gsk_...your_key_here
PORT=5002
NODE_ENV=development
```

---

## Setup & Run

### 1. Install dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure environment

Copy `backend/.env.example` to `backend/.env` and fill in your values.

### 3. Run backend

```bash
cd backend
npm run dev
# Runs on http://localhost:5002
```

### 4. Run frontend

```bash
cd frontend
npm run dev
# Runs on http://localhost:5174
```

---

## How OCR Works

1. User uploads a file (JPG/JPEG/PNG/PDF)
2. File is stored in MongoDB GridFS
3. OCR runs on the buffer in memory:
   - **Images**: Tesseract.js recognizes English text
   - **PDFs**: `pdf-parse` extracts the text layer (for digital PDFs)
4. If OCR fails or returns empty text, the document is marked `failed`
5. Raw OCR text is stored hidden (`ocrTextHidden`) - not shown in UI

---

## How Groq Extraction Works

1. OCR text is sent to Groq Llama 3.3 70B with a strict structured prompt
2. Groq returns valid JSON with:
   - `documentType` - classified document category
   - `summaryPoints` - 5-10 bullet summary points
   - `fields` - all extracted key-value pairs with category, confidence, source line
   - `tables` - reconstructed tabular data with columns and rows
   - `warnings` - any extraction uncertainties
3. Data is saved to MongoDB on the Document record
4. If Groq fails, document is marked `failed` with an error message

---

## How Table Extraction Works

- The backend builds display tables from structured AI-extracted transport fields
- Each table has: `title`, `columns[]`, `rows[]`, `confidence`, `sourceHint`
- Tables are rendered in horizontally scrollable views on mobile
- If extraction is uncertain, the AI adds a warning

---

## How Document Chat Works

- Chat is document-scoped - each document has its own message thread
- Groq is given the document's fields, tables, summary, and OCR text as context
- It is instructed to answer **only** from that context
- If information isn't found: returns `"This information is not available in the uploaded document."`
- Corrected field values are used in chat answers
- Chat history is limited to 50 messages per document

### Quick Action Buttons

| Button       | What it does                        |
|--------------|-------------------------------------|
| Summarize    | Returns 5-10 summary bullet points  |
| All Fields   | Lists every extracted field         |
| Tables       | Shows all extracted tables          |
| IDs          | Shows ID/reference fields only      |
| Amounts      | Shows monetary fields only          |
| Tax / GST    | Shows GST, CGST, SGST, IGST fields  |
| Dates        | Shows date fields only              |

---

## How Corrections Work

1. On Document Detail -> Fields tab, click **Edit** on any field
2. Enter the corrected value and save
3. Correction is stored in the `Correction` model with old/new value history
4. The corrected value becomes the active value shown in fields and used in chat

---

## API Endpoints

| Method | Endpoint                                  | Description                  |
|--------|-------------------------------------------|------------------------------|
| POST   | `/api/documents/upload`                   | Upload and process document  |
| GET    | `/api/documents`                          | List all documents           |
| GET    | `/api/documents/:id`                      | Get single document          |
| GET    | `/api/documents/:id/download`             | Download original file       |
| POST   | `/api/documents/:id/reprocess`            | Re-run OCR + AI              |
| DELETE | `/api/documents/:id`                      | Soft-delete document         |
| PATCH  | `/api/documents/:id/fields/:key/correct`  | Correct a field value        |
| GET    | `/api/documents/:id/chat`                 | Get chat history             |
| POST   | `/api/documents/:id/chat`                 | Send chat message            |

---

## Known MVP Limitations

- Image-based (scanned) PDFs may not extract well - upload as JPG/PNG instead
- Groq API key must be a valid key for `groq-sdk`
- No authentication - single-user local workflow only
- MongoDB Atlas requires IP whitelisting (`0.0.0.0/0` for development)
- OCR accuracy depends on image quality and document clarity
- Processing takes 15-60 seconds depending on document and network speed

---

## Version 2 Ideas (Not built)

- Admin dashboard and user roles
- Signup/login with approval flow
- Multi-user access control
- Better OCR (Google Vision, AWS Textract)
- Export to Excel / PDF
- Light mode toggle
- Batch upload (multiple files)
- Multiple document comparison
- Advanced audit logs
- Company/worker database matching
- Native mobile app
