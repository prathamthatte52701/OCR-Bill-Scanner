import { Link } from 'react-router-dom'

const statusStyles = {
  uploaded: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  processed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
}

const statusLabels = {
  uploaded: 'Uploaded',
  processed: 'Processed',
  failed: 'Failed',
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function formatSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function getFormat(mimeType) {
  if (!mimeType) return '-'
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'JPEG'
  if (mimeType.includes('png')) return 'PNG'
  return mimeType.split('/')[1]?.toUpperCase() || 'FILE'
}

function getFileBadge(mimeType) {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType?.startsWith('image/')) return 'IMG'
  return 'DOC'
}

function MetadataIcon({ type }) {
  if (type === 'calendar') {
    return (
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M8 2v4" />
        <path d="M16 2v4" />
        <path d="M3 10h18" />
        <path d="M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      </svg>
    )
  }

  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  )
}

function MetadataItem({ label, value, icon }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-xl border border-white/7 bg-white/[0.035] px-2.5 py-2 text-[11.6px] min-[420px]:gap-2 min-[420px]:px-3 min-[420px]:text-[12.6px]">
      <span className="shrink-0 text-slate-500"><MetadataIcon type={icon} /></span>
      <span className="shrink-0 text-slate-500">{label}:</span>
      <span className="whitespace-nowrap font-medium text-slate-300">{value}</span>
    </div>
  )
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.6px] font-bold ${statusStyles[status] || statusStyles.uploaded}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_12px_currentColor]" />
      {statusLabels[status] || statusLabels.uploaded}
    </span>
  )
}

function FileIconBadge({ label }) {
  return (
    <div className="relative grid h-24 w-24 shrink-0 place-items-center">
      <div className="absolute inset-2 rounded-2xl bg-blue-500/20 blur-xl" />
      <div className="relative h-20 w-16 rounded-[14px] border border-blue-300/35 bg-blue-500/10 shadow-[0_0_34px_rgba(37,99,235,0.28)]">
        <div className="absolute right-0 top-0 h-5 w-5 rounded-bl-xl border-b border-l border-blue-300/30 bg-slate-950/70" />
        <div className="absolute left-3 top-5 h-1.5 w-8 rounded-full bg-blue-300/70" />
        <div className="absolute left-3 top-8 h-1.5 w-7 rounded-full bg-blue-400/40" />
        <div className="absolute left-3 top-11 h-1.5 w-9 rounded-full bg-blue-400/35" />
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-blue-300/45 bg-slate-950/80 px-2 py-1 text-[12.6px] font-black text-blue-100">
          {label}
        </div>
      </div>
    </div>
  )
}

export default function DocumentCard({ doc }) {
  const status = doc.uploadStatus || 'uploaded'
  const format = getFormat(doc.mimeType)
  const fileBadge = getFileBadge(doc.mimeType)

  return (
    <article className="group relative overflow-hidden rounded-3xl border border-blue-300/12 bg-slate-900/64 p-5 shadow-[0_24px_90px_rgba(2,8,23,0.34)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-blue-300/40 hover:shadow-[0_28px_110px_rgba(37,99,235,0.16)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(37,99,235,0.22),transparent_26%),linear-gradient(135deg,rgba(59,130,246,0.08),transparent_42%)] opacity-80" />

      <div className="relative flex items-start gap-4">
        <FileIconBadge label={fileBadge} />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-lg font-black tracking-tight text-white">{fileBadge} {doc.autoName}</h3>
              <p className="mt-1 truncate text-[14.7px] text-slate-500">{doc.originalFilename}</p>
            </div>
            <StatusBadge status={status} />
          </div>

          <div className="mt-4 grid grid-cols-[1fr_auto] gap-3 text-[14.7px]">
            <p className="min-w-0 text-slate-400">
              <span className="text-slate-500">Type: </span>
              <span className="text-slate-300">{doc.documentType || '-'}</span>
            </p>
            <p className="whitespace-nowrap text-slate-400">
              <span className="text-slate-500">Size: </span>
              <span className="text-slate-300">{formatSize(doc.size)}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-2">
        <MetadataItem icon="calendar" label="Uploaded" value={formatDate(doc.createdAt)} />
        <MetadataItem icon="file" label="Format" value={format} />
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-3">
        <Link
          to={`/documents/${doc._id}`}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-300/18 bg-slate-950/32 px-3 py-3 text-[14.7px] font-bold text-slate-200 no-underline transition-all hover:border-blue-300/35 hover:bg-blue-500/10"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          View Details
        </Link>
        {status === 'processed' ? (
          <Link
            to={`/documents/${doc._id}/chat`}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-3 py-3 text-[14.7px] font-black text-white no-underline shadow-[0_16px_38px_rgba(37,99,235,0.28)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_48px_rgba(37,99,235,0.38)]"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
            </svg>
            Chat
          </Link>
        ) : (
          <span className="inline-flex cursor-not-allowed items-center justify-center rounded-xl border border-white/8 bg-white/[0.025] px-3 py-3 text-[14.7px] font-bold text-slate-600">
            Chat
          </span>
        )}
      </div>
    </article>
  )
}
