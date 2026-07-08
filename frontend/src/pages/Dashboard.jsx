import { Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import api from '../utils/api'
import challanRouteVisual from '../assets/transport-bill-route-visual.png'

const features = [
  { icon: 'UP', title: 'Upload', desc: 'Upload delivery challans in JPG, JPEG, PNG, or PDF.' },
  { icon: 'OC', title: 'Auto-Split OCR', desc: 'Automatically splits each page into header and line-items sections, then extracts text from both.' },
  { icon: 'AI', title: 'AI Analysis', desc: 'Identify consignee, consignor, invoice details, line items, and GST tax totals.' },
  { icon: 'CH', title: 'Chat', desc: 'Ask questions and get answers about your delivery challans.' },
  { icon: 'ED', title: 'Edit', desc: 'Review and correct extracted field values instantly.' },
  { icon: 'DL', title: 'Download', desc: 'Download originals or remove documents when needed.' },
]

const supportedTypes = [
  'Delivery Challan',
  'Consignor/Consignee Bill',
  'Rule 55 CGST Challan',
]

function formatDate(dateStr) {
  if (!dateStr) return 'Not processed'
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSize(bytes) {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function isToday(dateStr) {
  if (!dateStr) return false
  const date = new Date(dateStr)
  const today = new Date()
  return date.toDateString() === today.toDateString()
}

function StatusBadge({ status }) {
  const styles = {
    processed: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    failed: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
    uploaded: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  }

  return (
    <span className={`rounded-full border px-2.5 py-1 text-[11.6px] font-bold uppercase tracking-[0.14em] ${styles[status] || styles.uploaded}`}>
      {status || 'uploaded'}
    </span>
  )
}

function MiniSparkline({ color = 'blue' }) {
  const stroke = {
    blue: '#60a5fa',
    green: '#34d399',
    red: '#fb7185',
    violet: '#a78bfa',
  }[color]

  return (
    <svg className="h-9 w-20 opacity-85" viewBox="0 0 96 40" fill="none" aria-hidden="true">
      <path d="M2 31C12 30 16 18 25 21C35 25 37 12 48 15C60 19 62 7 73 10C82 12 86 5 94 7" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M2 31C12 30 16 18 25 21C35 25 37 12 48 15C60 19 62 7 73 10C82 12 86 5 94 7V40H2V31Z" fill={`url(#spark-${color})`} opacity="0.22" />
      <defs>
        <linearGradient id={`spark-${color}`} x1="48" x2="48" y1="6" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor={stroke} />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function StatCard({ icon, label, value, helper, color }) {
  const accents = {
    blue: 'from-blue-500/20 to-cyan-400/5 border-blue-300/15 text-blue-200 shadow-blue-950/20',
    green: 'from-emerald-500/20 to-cyan-400/5 border-emerald-300/15 text-emerald-200 shadow-emerald-950/20',
    red: 'from-rose-500/20 to-orange-400/5 border-rose-300/15 text-rose-200 shadow-rose-950/20',
    violet: 'from-violet-500/20 to-blue-400/5 border-violet-300/15 text-violet-200 shadow-violet-950/20',
  }

  return (
    <div className={`group relative overflow-hidden rounded-2xl border bg-slate-900/68 p-4 shadow-xl backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-blue-300/25 ${accents[color]}`}>
      <div className={`absolute inset-0 bg-gradient-to-br ${accents[color]} opacity-80`} />
      <div className="relative flex items-start justify-between gap-3">
        <div>
          <span className="mb-3 grid h-10 w-10 place-items-center rounded-2xl border border-white/10 bg-white/[0.06] text-[12.6px] font-black tracking-wide">
            {icon}
          </span>
          <p className="text-2xl font-black tracking-tight text-white">{value}</p>
          <p className="mt-1 text-[14.7px] font-semibold text-slate-300">{label}</p>
          <p className="mt-1.5 text-[12.6px] text-slate-500">{helper}</p>
        </div>
        <MiniSparkline color={color} />
      </div>
    </div>
  )
}

function HeroIllustration() {
  return (
    <div className="relative min-h-[270px] overflow-hidden rounded-[28px] border border-blue-300/12 bg-slate-950/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <img
        src={challanRouteVisual}
        alt="AI delivery challan route extraction visual"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-slate-950/15 via-transparent to-slate-950/30" />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-slate-950/70 to-transparent" />
      <div className="absolute bottom-5 right-5 rounded-2xl border border-cyan-300/20 bg-slate-900/82 px-4 py-3 shadow-[0_18px_60px_rgba(8,47,73,0.38)] backdrop-blur-xl">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-cyan-200">AI Extraction</p>
        <p className="mt-1 text-2xl font-black text-white">Ready</p>
      </div>
    </div>
  )
}

function RecentDocumentRow({ doc }) {
  return (
    <Link
      to={doc.uploadStatus === 'processed' ? `/documents/${doc._id}/chat` : `/documents/${doc._id}`}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] px-4 py-3 no-underline transition-all hover:border-blue-300/25 hover:bg-blue-500/[0.055]"
    >
      <span className="grid h-11 w-11 place-items-center rounded-2xl border border-blue-300/15 bg-blue-500/10 text-[12.6px] font-black text-blue-200">
        {doc.mimeType === 'application/pdf' ? 'PDF' : 'IMG'}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14.7px] font-bold text-white">{doc.autoName}</span>
        <span className="mt-1 block truncate text-[12.6px] text-slate-500">{doc.documentType || doc.originalFilename}</span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.6px] font-medium text-slate-600">
          <span>{formatDate(doc.createdAt)}</span>
          <span>{formatSize(doc.size)}</span>
          <span>{doc.mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}</span>
        </span>
      </span>
      <StatusBadge status={doc.uploadStatus} />
    </Link>
  )
}

function QualityPanel({ stats, training }) {
  const processed = stats.processed || 0
  const failed = stats.failed || 0
  const totalChecked = processed + failed
  const quality = totalChecked ? Math.round((processed / totalChecked) * 100) : 100
  const ring = `conic-gradient(#38bdf8 ${quality * 3.6}deg, rgba(30,41,59,0.9) 0deg)`

  return (
    <div className="rounded-[28px] border border-blue-300/12 bg-slate-900/68 p-6 shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-black tracking-tight text-white">Quality</h2>
          <p className="mt-1 text-[14.7px] text-slate-500">Extraction history - {training.trainedCount || processed} documents processed</p>
        </div>
        <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11.6px] font-bold uppercase tracking-[0.14em] text-cyan-200">Live</span>
      </div>

      <div className="mt-8 flex items-center gap-6">
        <div className="grid h-32 w-32 shrink-0 place-items-center rounded-full p-2" style={{ background: ring }}>
          <div className="grid h-full w-full place-items-center rounded-full border border-white/8 bg-slate-950">
            <div className="text-center">
              <p className="text-3xl font-black text-white">{quality}%</p>
              <p className="text-[12.6px] font-bold uppercase tracking-[0.18em] text-slate-500">Status</p>
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {[
            ['Processed documents', processed],
            ['Failed documents', failed],
            ['User-corrected records', training.correctedCount || 0],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.035] px-3 py-2">
              <span className="flex items-center gap-2 text-[14.7px] text-slate-300">
                <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.8)]" />
                {label}
              </span>
              <span className="text-[14.7px] font-black text-white">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function FeatureCard({ feature, index }) {
  const colors = ['text-blue-200', 'text-cyan-200', 'text-violet-200', 'text-emerald-200', 'text-amber-200', 'text-sky-200']

  return (
    <div className="group rounded-2xl border border-blue-300/10 bg-slate-900/62 p-5 shadow-xl shadow-slate-950/20 backdrop-blur-xl transition-all hover:-translate-y-1 hover:border-blue-300/25 hover:bg-slate-900/80">
      <span className={`mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.045] text-[12.6px] font-black ${colors[index % colors.length]}`}>
        {feature.icon}
      </span>
      <h3 className="text-base font-black text-white">{feature.title}</h3>
      <p className="mt-2 text-[14.7px] leading-6 text-slate-500">{feature.desc}</p>
    </div>
  )
}

function FeedbackAnalyticsPanel({ feedback }) {
  const { avgRating, totalFeedback, top3 } = feedback

  return (
    <div className="rounded-[28px] border border-blue-300/12 bg-slate-900/68 p-5 shadow-2xl shadow-slate-950/30 backdrop-blur-xl sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black tracking-tight text-white">AI Quality Analytics</h2>
          <p className="mt-1 text-[14.7px] text-slate-500">Based on user ratings for AI chat responses</p>
        </div>
        <span className="shrink-0 rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-1 text-[11.6px] font-bold uppercase tracking-[0.14em] text-amber-200">
          {totalFeedback} ratings
        </span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-amber-300/15 bg-amber-500/[0.07] p-4 text-center">
          <p className="text-3xl font-black text-amber-300">{avgRating > 0 ? avgRating.toFixed(1) : '—'}</p>
          <p className="mt-1 text-[12.6px] font-semibold text-slate-400">Avg Rating / 10</p>
        </div>
        <div className="rounded-2xl border border-blue-300/15 bg-blue-500/[0.07] p-4 text-center">
          <p className="text-3xl font-black text-blue-300">{totalFeedback}</p>
          <p className="mt-1 text-[12.6px] font-semibold text-slate-400">Total Feedback</p>
        </div>
      </div>

      {top3.length > 0 && (
        <>
          <p className="mb-3 text-[12.6px] font-bold uppercase tracking-[0.16em] text-slate-500">Top 3 Highest-Rated</p>
          <div className="space-y-2">
            {top3.map((item, i) => (
              <div key={item._id || i} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] px-4 py-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-[12.6px] font-black text-amber-300">
                  #{i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.7px] font-bold text-white">{item.autoName || 'Unknown'}</p>
                  <p className="truncate text-[12.6px] text-slate-500">{item.consignor?.name || item.documentType || ''}</p>
                </div>
                <span className="shrink-0 text-[14.7px] font-black text-amber-300">{item.avgRating}/10</span>
              </div>
            ))}
          </div>
        </>
      )}

      {totalFeedback === 0 && (
        <div className="rounded-2xl border border-dashed border-blue-300/14 bg-white/[0.025] px-5 py-8 text-center">
          <p className="text-[14.7px] font-bold text-slate-300">No ratings yet.</p>
          <p className="mt-2 text-[14.7px] text-slate-500">Rate AI responses in the chat to see analytics here.</p>
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, processed: 0, failed: 0, processedToday: 0 })
  const [recentDocs, setRecentDocs] = useState([])
  const [training, setTraining] = useState({ trainedCount: 0, correctedCount: 0 })
  const [feedback, setFeedback] = useState({ avgRating: 0, totalFeedback: 0, top3: [] })

  useEffect(() => {
    api.get('/documents').then(res => {
      const docs = res.data?.documents || []
      setStats({
        total: docs.length,
        processed: docs.filter(d => d.uploadStatus === 'processed').length,
        failed: docs.filter(d => d.uploadStatus === 'failed').length,
        processedToday: docs.filter(d => d.uploadStatus === 'processed' && isToday(d.processedAt || d.reprocessedAt || d.updatedAt)).length,
      })
      setRecentDocs(docs.slice(0, 3))
    }).catch(() => {})

    api.get('/documents/training-stats').then(res => {
      setTraining(res.data || { trainedCount: 0, correctedCount: 0 })
    }).catch(() => {})

    api.get('/documents/feedback-stats').then(res => {
      setFeedback(res.data || { avgRating: 0, totalFeedback: 0, top3: [] })
    }).catch(() => {})
  }, [])

  return (
    <div className="relative min-h-full overflow-hidden bg-[#020817]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(37,99,235,0.22),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(6,182,212,0.16),transparent_24%),linear-gradient(180deg,rgba(15,23,42,0.2),rgba(2,6,23,0.95))]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.035)_1px,transparent_1px)] bg-[size:56px_56px] opacity-55" />

      <main className="relative mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-10">
        <section className="grid items-center gap-7 rounded-[28px] border border-blue-300/12 bg-slate-900/58 p-5 shadow-[0_32px_110px_rgba(2,8,23,0.48)] backdrop-blur-xl sm:p-7 lg:grid-cols-[1.02fr_0.98fr] lg:p-8">
          <div className="max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-blue-300/20 bg-blue-500/10 px-4 py-2 text-[12.6px] font-bold uppercase tracking-[0.18em] text-blue-200">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.9)]" />
              AI-Powered Delivery Challan Intelligence
            </div>
            <h1 className="text-4xl font-black leading-[1.07] tracking-[-0.04em] text-white sm:text-5xl xl:text-[56px]">
              Extract. Verify. Understand.
              <span className="block">Delivery challans in <span className="text-blue-400 drop-shadow-[0_0_28px_rgba(59,130,246,0.55)]">seconds.</span></span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-400">
              Upload Consignor-Consignee delivery challans and let AI extract party details, invoice info, line items, and GST totals instantly.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/upload"
                className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-blue-600 to-cyan-500 px-6 py-3.5 text-[14.7px] font-black text-white no-underline shadow-[0_18px_45px_rgba(37,99,235,0.34)] transition-all hover:-translate-y-0.5 hover:shadow-[0_22px_60px_rgba(37,99,235,0.45)] focus:outline-none focus:ring-2 focus:ring-blue-300/60"
              >
                Upload Document
              </Link>
              <Link
                to="/documents"
                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.045] px-6 py-3.5 text-[14.7px] font-black text-slate-200 no-underline transition-all hover:-translate-y-0.5 hover:border-blue-300/30 hover:bg-blue-500/10 focus:outline-none focus:ring-2 focus:ring-blue-300/40"
              >
                My Documents
              </Link>
            </div>
          </div>

          <HeroIllustration />
        </section>

        <section className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon="TD" label="Total Documents" value={stats.total} helper="Delivery challans in workspace" color="blue" />
          <StatCard icon="OK" label="Processed" value={stats.processed} helper="Ready for review and chat" color="green" />
          <StatCard icon="ER" label="Failed" value={stats.failed} helper="Needs reprocess or review" color="red" />
          <StatCard icon="24" label="Processed Today" value={stats.processedToday} helper="Completed in today's run" color="violet" />
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[1.12fr_0.88fr]">
          <div className="rounded-[28px] border border-blue-300/12 bg-slate-900/68 p-5 shadow-2xl shadow-slate-950/30 backdrop-blur-xl sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black tracking-tight text-white">Recent Documents</h2>
                <p className="mt-1 text-[14.7px] text-slate-500">Latest delivery challans processed by ChallanIntel AI</p>
              </div>
              <Link to="/documents" className="shrink-0 rounded-full border border-blue-300/20 bg-blue-500/10 px-4 py-2 text-[12.6px] font-black uppercase tracking-[0.14em] text-blue-200 no-underline transition-colors hover:bg-blue-500/15">
                View all
              </Link>
            </div>

            {recentDocs.length > 0 ? (
              <div className="space-y-3">
                {recentDocs.map(doc => (
                  <RecentDocumentRow key={doc._id} doc={doc} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-blue-300/14 bg-white/[0.025] px-5 py-10 text-center">
                <p className="text-[14.7px] font-bold text-slate-300">No delivery challans uploaded yet.</p>
                <p className="mt-2 text-[14.7px] text-slate-500">Upload a bill to see recent document activity here.</p>
              </div>
            )}
          </div>

          <QualityPanel stats={stats} training={training} />
        </section>

        <section className="mt-6">
          <FeedbackAnalyticsPanel feedback={feedback} />
        </section>

        <section className="mt-10">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-[12.6px] font-black uppercase tracking-[0.22em] text-blue-300/80">Capabilities</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-white">What ChallanIntel AI does</h2>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {features.map((feature, index) => (
              <FeatureCard key={feature.title} feature={feature} index={index} />
            ))}
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-blue-300/12 bg-slate-900/68 p-5 shadow-2xl shadow-slate-950/25 backdrop-blur-xl sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <span className="grid h-12 w-12 place-items-center rounded-2xl border border-blue-300/15 bg-blue-500/10 text-[12.6px] font-black text-blue-200">DOC</span>
              <div>
                <h2 className="text-lg font-black text-white">Supported Document Types</h2>
                <p className="mt-1 text-[14.7px] text-slate-500">Focused intake for delivery challan operations.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {supportedTypes.map(type => (
                <span key={type} className="rounded-full border border-white/10 bg-white/[0.045] px-3 py-1.5 text-[12.6px] font-bold text-slate-300">
                  {type}
                </span>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
