import { useEffect, useMemo } from 'react'

export default function DocumentPreview({ file }) {
  const previewUrl = useMemo(() => {
    if (!file) return ''
    return URL.createObjectURL(file)
  }, [file])

  useEffect(() => {
    if (!previewUrl) return undefined
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  if (!file) return null

  const isImage = file.type.startsWith('image/')
  const isPDF = file.type === 'application/pdf'
  const sizeMB = (file.size / (1024 * 1024)).toFixed(2)

  return (
    <div className="overflow-hidden rounded-3xl border border-blue-300/12 bg-slate-950/44 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex items-center justify-between border-b border-blue-300/10 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">{file.name}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">{sizeMB} MB - {file.type.split('/')[1]?.toUpperCase()}</p>
        </div>
        <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-emerald-300">
          Ready
        </span>
      </div>

      <div className="p-4">
        {isImage && (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950">
            <img
              src={previewUrl}
              alt="Document preview"
              className="w-full max-h-80 object-contain"
            />
          </div>
        )}
        {isPDF && (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950">
            <iframe
              src={previewUrl}
              title="PDF preview"
              className="w-full h-72"
            />
          </div>
        )}
      </div>
    </div>
  )
}
