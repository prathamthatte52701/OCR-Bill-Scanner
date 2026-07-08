import { useState } from 'react'

function formatTimestamp(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

function RatingBar({ messageId, onRate }) {
  const [selected, setSelected] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleRate(rating) {
    if (submitting || selected !== null) return
    setSubmitting(true)
    setSelected(rating)
    try {
      await onRate(messageId, rating)
    } catch {
      // rating saved best-effort
    }
    setSubmitting(false)
  }

  if (selected !== null) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[12.6px] text-slate-500">
        <span className="text-amber-400">★</span>
        <span>Rated {selected}/10 — Thanks!</span>
      </div>
    )
  }

  return (
    <div className="mt-2.5">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">Rate this response</p>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
          <button
            key={n}
            type="button"
            onClick={() => handleRate(n)}
            disabled={submitting}
            className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-slate-800/60 text-[12.6px] font-bold text-slate-400 transition-all hover:border-amber-400/40 hover:bg-amber-500/10 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ChatMessageBubble({ message, onRate }) {
  const isUser = message.role === 'user'
  const canRate = !isUser && message._id && typeof onRate === 'function'

  return (
    <div className={`mb-5 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[86%] sm:max-w-[76%] ${isUser ? 'order-2' : 'order-1'}`}>
        {!isUser && (
          <div className="mb-2 flex items-center gap-2">
            <div className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-blue-600 to-cyan-400 text-[10.5px] font-black text-white shadow-[0_0_22px_rgba(37,99,235,0.34)]">
              TI
            </div>
            <span className="text-[12.6px] font-semibold text-slate-500">ChallanIntel AI</span>
          </div>
        )}

        <div className={`rounded-2xl px-4 py-3 text-[14.7px] leading-relaxed shadow-[0_16px_46px_rgba(2,8,23,0.24)] ${
          isUser
            ? 'rounded-br-md border border-blue-300/25 bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-blue-950/30'
            : 'rounded-bl-md border border-white/10 bg-slate-800/72 text-slate-100'
        }`}>
          {message.message.split('\n').map((line, i, arr) => (
            <span key={i}>
              {line}
              {i < arr.length - 1 && <br />}
            </span>
          ))}
        </div>

        {canRate && <RatingBar messageId={message._id} onRate={onRate} />}

        <p className={`mt-1.5 text-[12.6px] text-slate-600 ${isUser ? 'text-right' : 'text-left'}`}>
          {formatTimestamp(message.createdAt)}
        </p>
      </div>
    </div>
  )
}
