import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import api from '../utils/api'
import DocumentChat from '../components/DocumentChat'
import CorrectionModal from '../components/CorrectionModal'

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getFileType(mimeType) {
  if (!mimeType) return '-'
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType.startsWith('image/')) return 'Image'
  return mimeType.split('/')[1]?.toUpperCase() || 'File'
}

function firstValue(...values) {
  const value = values.find(item => item !== undefined && item !== null && item !== '')
  return value ?? '-'
}

function formatAmount(value) {
  if (value === undefined || value === null || value === '' || value === '-') return '-'
  const raw = String(value)
  return raw.toLowerCase().includes('rs') ? raw : `Rs ${raw}`
}

function StatusBadge({ status }) {
  const isReady = status === 'processed'
  return (
    <span className={`inline-flex items-center rounded-xl border px-3 py-1.5 text-[12.6px] font-bold ${
      isReady
        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
        : 'border-amber-400/30 bg-amber-400/10 text-amber-300'
    }`}>
      {isReady ? 'Ready' : status || 'Uploaded'}
    </span>
  )
}

function MiniIcon({ children }) {
  return (
    <span className="grid h-5 min-w-5 place-items-center rounded-md border border-blue-300/15 bg-blue-500/10 px-1 text-[10.5px] font-bold text-blue-200">
      {children}
    </span>
  )
}

function PanelTitle({ icon, children }) {
  return (
    <div className="mb-4 flex items-center gap-2 text-[14.7px] font-bold text-blue-200">
      <MiniIcon>{icon}</MiniIcon>
      {children}
    </div>
  )
}

function MetaRow({ icon, label, value }) {
  return (
    <div className="grid grid-cols-[28px_1fr_1.15fr] items-start gap-2 text-[14.7px]">
      <MiniIcon>{icon}</MiniIcon>
      <span className="text-slate-500">{label}</span>
      <span className="break-words font-medium text-slate-200">{value}</span>
    </div>
  )
}

function DocumentIcon() {
  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-blue-300/25 bg-blue-500/15 text-blue-100 shadow-[0_0_24px_rgba(37,99,235,0.25)]">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v5h5" />
        <path d="M9 13h6" />
        <path d="M9 17h4" />
      </svg>
    </div>
  )
}

function DocumentContextPanel({ doc }) {
  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-blue-300/15 bg-slate-950/58 p-4 shadow-[0_24px_90px_rgba(2,8,23,0.34)] backdrop-blur-xl">
      <PanelTitle icon="DC">Document Context</PanelTitle>

      <div className="rounded-2xl border border-blue-300/14 bg-slate-900/46 p-4">
        <div className="flex items-start gap-3">
          <DocumentIcon />
          <div className="min-w-0">
            <h2 className="truncate text-base font-black text-white">{doc.autoName}</h2>
            <p className="mt-1 overflow-hidden text-ellipsis text-[14.7px] text-blue-100/70">{doc.documentType || 'Delivery Challan'} Chat</p>
          </div>
        </div>

        <div className="mt-5">
          <StatusBadge status={doc.uploadStatus} />
        </div>

        <div className="my-5 h-px bg-gradient-to-r from-transparent via-slate-600/60 to-transparent" />

        <div className="space-y-4">
          <MetaRow icon="ID" label="Uploaded by" value="Business Owner" />
          <MetaRow icon="ON" label="Uploaded on" value={formatDateTime(doc.createdAt)} />
          <MetaRow icon="TY" label="File type" value={getFileType(doc.mimeType)} />
          <MetaRow icon="PG" label="Pages" value={doc.pageCount || doc.pages || 1} />
          <MetaRow icon="LN" label="Language" value="English" />
        </div>
      </div>

      <div className="mt-auto hidden rounded-2xl border border-blue-300/12 bg-blue-500/[0.045] p-4 text-[14.7px] text-slate-400 lg:block">
        <div className="flex items-start gap-3">
          <MiniIcon>AI</MiniIcon>
          <p>AI responses are generated from the uploaded document content.</p>
        </div>
      </div>
    </aside>
  )
}

function InsightRow({ label, value }) {
  return (
    <div className="border-b border-white/8 py-3 last:border-b-0">
      <p className="text-[12.6px] font-medium text-slate-500">{label}</p>
      <p className="mt-1 break-words text-[14.7px] font-medium text-slate-100">{value}</p>
    </div>
  )
}

function QuickInsightsPanel({ doc }) {
  const consignee = firstValue(doc.consignee?.name)
  const consignor = firstValue(doc.consignor?.name)
  const invoiceNo = firstValue(doc.invoiceNo)
  const totalAmount = formatAmount(firstValue(doc.totals?.totalAmount))

  return (
    <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-blue-300/15 bg-slate-950/58 p-4 shadow-[0_24px_90px_rgba(2,8,23,0.34)] backdrop-blur-xl">
      <section>
        <PanelTitle icon="IN">Quick Insights</PanelTitle>
        <div className="rounded-2xl border border-blue-300/14 bg-slate-900/46 p-4">
          <InsightRow label="Consignee" value={consignee} />
          <InsightRow label="Consignor" value={consignor} />
          <InsightRow label="Invoice No" value={invoiceNo} />
          <InsightRow label="Total Amount" value={totalAmount} />
          <Link
            to={`/documents/${doc._id}`}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-blue-300/20 bg-slate-950/28 px-3 py-2.5 text-[14.7px] font-bold text-blue-200 no-underline transition-colors hover:border-blue-300/45 hover:bg-blue-500/10"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M7 17 17 7" />
              <path d="M8 7h9v9" />
            </svg>
            View Details
          </Link>
        </div>
      </section>

      <div className="rounded-2xl border border-blue-300/12 bg-blue-500/[0.045] p-4 text-[14.7px] text-slate-400">
        <div className="flex items-start gap-3">
          <MiniIcon>TP</MiniIcon>
          <p><span className="font-semibold text-slate-300">Tip:</span> Use the buttons below the chat for Full Summary, About, Consignee Details, Consigner Details, and Items &amp; Tax - or ask anything about this document directly.</p>
        </div>
      </div>
    </aside>
  )
}

function PageLoadingState() {
  return (
    <div className="min-h-[calc(100vh-104px)] bg-[#020817] px-4 py-6">
      <div className="mx-auto max-w-[1540px] rounded-2xl border border-blue-300/12 bg-slate-950/58 p-6">
        <div className="h-5 w-44 rounded-full bg-slate-800/80" />
        <div className="mt-6 grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
          {[0, 1, 2].map(item => (
            <div key={item} className="h-[520px] animate-pulse rounded-2xl border border-blue-300/10 bg-slate-900/50" />
          ))}
        </div>
      </div>
    </div>
  )
}

function PageErrorState({ message }) {
  return (
    <div className="min-h-[calc(100vh-104px)] bg-[#020817] px-4 py-10">
      <div className="mx-auto max-w-2xl rounded-2xl border border-rose-400/20 bg-rose-950/20 p-6 text-center">
        <p className="text-lg font-black text-white">Chat could not be loaded</p>
        <p className="mt-2 text-[14.7px] text-rose-100/70">{message}</p>
        <Link to="/documents" className="mt-5 inline-flex rounded-xl bg-blue-600 px-4 py-2 text-[14.7px] font-bold text-white no-underline">
          Back to Documents
        </Link>
      </div>
    </div>
  )
}

export default function DocumentChatPage() {
  const { id } = useParams()
  const [doc, setDoc] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [correctionField, setCorrectionField] = useState(null)
  const sendingRef = useRef(false)

  useEffect(() => {
    async function load() {
      try {
        const [docRes, chatRes] = await Promise.all([
          api.get(`/documents/${id}`),
          api.get(`/documents/${id}/chat`),
        ])
        setDoc(docRes.data?.document)
        setMessages(chatRes.data?.messages || [])
      } catch (err) {
        setError(err.userMessage || 'Failed to load document or chat history.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  async function handleSendMessage(text) {
    const messageText = text.trim()
    if (!messageText || sendingRef.current) return

    sendingRef.current = true
    setChatSending(true)

    const userMsg = { role: 'user', message: messageText, createdAt: new Date().toISOString() }
    setMessages(prev => [...prev, userMsg])

    try {
      const res = await api.post(`/documents/${id}/chat`, { message: messageText })
      const assistantMsg = res.data?.message
      if (!assistantMsg?.role || !assistantMsg?.message) {
        throw new Error('Invalid chat response.')
      }
      setMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        message: err.userMessage || 'Something went wrong. Please try again.',
        createdAt: new Date().toISOString(),
      }])
    } finally {
      sendingRef.current = false
      setChatSending(false)
    }
  }

  async function handleRate(messageId, rating) {
    try {
      await api.post(`/documents/${id}/chat/${messageId}/feedback`, { rating })
    } catch {
      // best-effort
    }
  }

  async function handleCorrect(field, newValue) {
    try {
      await api.patch(`/documents/${id}/fields/${field.normalizedKey}/correct`, {
        fieldLabel: field.label,
        fieldKey: field.normalizedKey,
        oldValue: field.correctedValue ?? field.value,
        newValue,
      })
      setCorrectionField(null)
      const res = await api.get(`/documents/${id}`)
      setDoc(res.data?.document)
    } catch {
      alert('Failed to save correction.')
    }
  }

  if (loading) return <PageLoadingState />
  if (error) return <PageErrorState message={error} />
  if (!doc) return null

  const canChat = doc.uploadStatus === 'processed'

  return (
    <div className="relative min-h-[calc(100vh-104px)] overflow-hidden bg-[#020817] px-3 py-4 text-slate-100 sm:px-5 lg:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(59,130,246,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.055)_1px,transparent_1px)] bg-[size:42px_42px] opacity-35" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_0%,rgba(37,99,235,0.18),transparent_30%),radial-gradient(circle_at_82%_15%,rgba(14,165,233,0.12),transparent_28%)]" />

      <div className="relative mx-auto grid max-w-[1540px] gap-4 xl:h-[calc(100vh-104px)] xl:grid-cols-[320px_minmax(0,1fr)_320px] 2xl:grid-cols-[340px_minmax(0,1fr)_340px]">
        <DocumentContextPanel doc={doc} />

        <section className="flex min-h-[680px] min-w-0 flex-col overflow-hidden rounded-2xl border border-blue-300/15 bg-slate-950/64 shadow-[0_24px_90px_rgba(2,8,23,0.34)] backdrop-blur-xl xl:min-h-0">
          <header className="border-b border-blue-300/12 px-4 py-4 sm:px-5">
            <Link to="/documents" className="mb-4 inline-flex items-center gap-2 text-[14.7px] font-semibold text-blue-200/80 no-underline transition-colors hover:text-blue-100">
              <span aria-hidden="true">&lt;-</span>
              Back to Documents
            </Link>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-black tracking-tight text-white">{doc.autoName}</h1>
                <p className="mt-1 truncate text-[14.7px] text-slate-400">{doc.documentType || 'Delivery Challan'} Chat</p>
              </div>

              <div className="flex items-center gap-2">
                <StatusBadge status={doc.uploadStatus} />
                <Link
                  to={`/documents/${id}`}
                  className="inline-flex items-center rounded-xl border border-blue-300/20 bg-slate-900/60 px-4 py-2 text-[14.7px] font-bold text-blue-200 no-underline transition-colors hover:border-blue-300/45 hover:bg-blue-500/10"
                >
                  View Details
                </Link>
              </div>
            </div>
          </header>

          {!canChat ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="max-w-md rounded-2xl border border-amber-400/20 bg-amber-950/15 p-6 text-center">
                <p className="text-lg font-black text-white">Chat not available</p>
                <p className="mt-2 text-[14.7px] text-amber-100/70">
                  {doc.uploadStatus === 'failed'
                    ? 'Document processing failed. Try reprocessing from the detail page.'
                    : 'Document is still being processed. Please wait.'}
                </p>
                <Link
                  to={`/documents/${id}`}
                  className="mt-5 inline-flex rounded-xl bg-slate-800 px-4 py-2 text-[14.7px] font-bold text-slate-200 no-underline transition-colors hover:bg-slate-700"
                >
                  View Document
                </Link>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <DocumentChat
                messages={messages}
                onSendMessage={handleSendMessage}
                loading={false}
                externalSending={chatSending}
                doc={doc}
                onRate={handleRate}
                onCorrect={(field) => setCorrectionField(field)}
              />
            </div>
          )}
        </section>

        <QuickInsightsPanel doc={doc} />
      </div>

      {correctionField && (
        <CorrectionModal
          field={correctionField}
          onSave={handleCorrect}
          onClose={() => setCorrectionField(null)}
        />
      )}
    </div>
  )
}
