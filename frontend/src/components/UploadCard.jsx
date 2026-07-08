import { useRef, useState } from 'react'

const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
const MAX_SIZE_MB = 5
const documentTypes = ['Delivery Challan', 'Consignor/Consignee Bill', 'Rule 55 CGST Challan']

export default function UploadCard({ onFileSelect, disabled }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')

  function validateFile(file) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return 'Only JPG, JPEG, PNG, and PDF files are allowed.'
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      return `File size must be ${MAX_SIZE_MB} MB or less.`
    }
    return null
  }

  function handleFile(file) {
    const err = validateFile(file)
    if (err) {
      setError(err)
      return
    }
    setError('')
    onFileSelect(file)
  }

  function handleChange(e) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div className="w-full">
      <div
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`group relative min-h-[330px] cursor-pointer overflow-hidden rounded-[26px] border border-dashed p-8 text-center transition-all sm:min-h-[370px] sm:p-10 ${
          disabled
            ? 'cursor-not-allowed border-slate-700/70 opacity-50'
            : dragOver
              ? 'border-cyan-300/80 bg-cyan-400/[0.075] shadow-[0_0_60px_rgba(6,182,212,0.18)]'
              : 'border-slate-500/60 bg-slate-950/30 hover:border-blue-300/75 hover:bg-blue-500/[0.045] hover:shadow-[0_0_70px_rgba(37,99,235,0.16)]'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.pdf"
          className="hidden"
          onChange={handleChange}
          disabled={disabled}
        />

        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_22%,rgba(37,99,235,0.16),transparent_38%)]" />
        <div className="relative flex min-h-[270px] flex-col items-center justify-center gap-5">
          <div className="grid h-24 w-24 place-items-center rounded-full border border-blue-300/25 bg-blue-500/10 shadow-[0_0_45px_rgba(37,99,235,0.28)]">
            <svg className="h-10 w-10 text-blue-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="M7 9l5-5 5 5" />
              <path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
            </svg>
          </div>

          <div>
            <p className="text-xl font-black text-white">Drop your document here</p>
            <p className="mt-2 text-base text-slate-500">or click to browse</p>
          </div>

          <div className="flex max-w-3xl flex-wrap justify-center gap-2">
            {documentTypes.map((type) => (
              <span key={type} className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-slate-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                {type}
              </span>
            ))}
          </div>

          <p className="text-sm font-medium text-slate-500">Upload delivery challan - JPG, JPEG, PNG, PDF - max 5MB</p>
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          {error}
        </div>
      )}
    </div>
  )
}
