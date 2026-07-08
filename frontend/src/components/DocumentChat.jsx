import { useState, useRef, useEffect } from 'react'
import ChatMessageBubble from './ChatMessageBubble'
import DocumentDetailsPanel from './DocumentDetailsPanel'
import LoadingState from './LoadingState'

export default function DocumentChat({ messages, onSendMessage, loading, externalSending = false, doc, onRate, onCorrect }) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const messagesRef = useRef(null)
  const isSending = sending || externalSending

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages])

  async function handleSend(text) {
    const msg = (text || input).trim()
    if (!msg || isSending) return
    setInput('')
    setSending(true)
    try {
      await onSendMessage(msg)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950/36">
      <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
        {loading ? (
          <LoadingState message="Loading chat history..." />
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl border border-blue-300/18 bg-blue-500/10 text-[14.7px] font-black text-blue-200 shadow-[0_0_34px_rgba(37,99,235,0.2)]">
              AI
            </div>
            <p className="font-bold text-slate-200">Ask anything about this delivery challan</p>
            <p className="max-w-sm text-[14.7px] text-slate-500">Type your question about consignee, consignor, invoice number, line items, or tax totals below.</p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <ChatMessageBubble key={msg._id || i} message={msg} onRate={onRate} />
          ))
        )}

        {isSending && (
          <div className="mb-4 flex justify-start">
            <div className="rounded-2xl rounded-bl-md border border-white/10 bg-slate-800/72 px-4 py-3">
              <div className="flex gap-1.5">
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-300/70"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <DocumentDetailsPanel doc={doc} onCorrect={onCorrect} />

      <div className="border-t border-blue-300/12 bg-slate-950/82 px-4 py-3">
        <div className="flex items-end gap-2 rounded-2xl border border-blue-300/20 bg-slate-900/70 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_42px_rgba(2,8,23,0.28)] transition-colors focus-within:border-blue-300/55">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-500">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Ask about this document..."
            rows={1}
            disabled={isSending}
            className="min-h-10 flex-1 resize-none bg-transparent px-1 py-2.5 text-[14.7px] text-white placeholder-slate-600 outline-none disabled:opacity-50"
            style={{ maxHeight: '120px' }}
          />
          <button
            type="button"
            onClick={() => handleSend()}
            disabled={!input.trim() || isSending}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-600 to-blue-500 text-white shadow-[0_12px_30px_rgba(37,99,235,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(37,99,235,0.42)] disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Send message"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m22 2-7 20-4-9-9-4 20-7Z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 2 11 13" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
