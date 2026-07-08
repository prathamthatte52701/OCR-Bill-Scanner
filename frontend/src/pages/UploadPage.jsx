import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../utils/api'
import UploadCard from '../components/UploadCard'
import DocumentPreview from '../components/DocumentPreview'
import transportRouteVisual from '../assets/transport-bill-route-visual.png'

function LogisticsUploadIllustration() {
  return (
    <div className="relative mt-10 hidden min-h-[310px] overflow-hidden rounded-[30px] border border-blue-300/10 bg-slate-950/20 lg:block">
      <img
        src={transportRouteVisual}
        alt="Transport bill upload route extraction visual"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/55 via-transparent to-slate-950/10" />
      <div className="absolute left-5 top-5 rounded-full border border-blue-300/20 bg-blue-500/12 px-4 py-2 text-[10.5px] font-bold uppercase tracking-[0.18em] text-blue-100 backdrop-blur-xl">
        Delivery Challan Intake
      </div>
    </div>
  )
}

function GuidelineCard() {
  return (
    <div className="rounded-3xl border border-blue-300/12 bg-slate-950/44 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex gap-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-blue-300/20 bg-blue-500/15 text-[14.7px] font-black text-blue-200 shadow-[0_0_28px_rgba(37,99,235,0.24)]">i</span>
        <div className="space-y-2 text-[14.7px] leading-6 text-slate-400">
          <p>- Accepted formats: JPG, JPEG, PNG, PDF</p>
          <p>- Maximum file size: 5 MB</p>
          <p>- PDF limit: 4 pages maximum</p>
          <p>- English language documents only</p>
          <p>- Page is auto-split into header and line-items sections - only one upload needed</p>
          <p>- Only printed text is extracted; handwriting, stamps, and signatures are ignored</p>
          <p>- Processing may take 20-70 seconds depending on document complexity</p>
        </div>
      </div>
    </div>
  )
}

function UploadProcessingState({ message }) {
  return (
    <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-blue-300/12 bg-slate-950/34 px-4 py-20 text-center">
      <div className="relative h-20 w-20">
        <div className="h-20 w-20 rounded-full border border-blue-300/15 bg-blue-500/10 shadow-[0_0_48px_rgba(37,99,235,0.2)]" />
        <div className="absolute inset-0 h-20 w-20 animate-spin rounded-full border-2 border-transparent border-r-cyan-300 border-t-blue-500" />
        <div className="absolute inset-4 flex items-center justify-center rounded-full border border-white/10 bg-slate-950">
          <span className="text-[12.6px] font-black text-blue-200">OCR</span>
        </div>
      </div>
      <div>
        <p className="text-lg font-black text-white">{message}</p>
        <p className="mt-2 text-[14.7px] text-slate-500">This may take a few moments.</p>
      </div>
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-2 w-2 animate-bounce rounded-full bg-blue-400"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  )
}

export default function UploadPage() {
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('idle') // idle | uploading | processing | done | error
  const [error, setError] = useState('')
  const pollRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  function handleFileSelect(f) {
    setFile(f)
    setStatus('idle')
    setError('')
  }

  async function handleUpload() {
    if (!file) return
    setStatus('uploading')
    setError('')

    try {
      const formData = new FormData()
      formData.append('document', file)

      const res = await api.post('/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })

      const docId = res.data?.document?._id
      if (!docId) throw new Error('Upload failed: no document ID returned.')

      setStatus('processing')

      // Poll until processed or failed
      if (pollRef.current) clearInterval(pollRef.current)
      let attempts = 0
      pollRef.current = setInterval(async () => {
        attempts++
        let shouldTimeout = false
        try {
          const docRes = await api.get(`/documents/${docId}`)
          const doc = docRes.data?.document

          if (doc?.uploadStatus === 'processed') {
            clearInterval(pollRef.current)
            pollRef.current = null
            setStatus('done')
            setTimeout(() => navigate(`/documents/${docId}/chat`), 800)
          } else if (doc?.uploadStatus === 'failed') {
            clearInterval(pollRef.current)
            pollRef.current = null
            setStatus('error')
            setError(doc.processingError || 'Something went wrong while processing this document.')
          } else if (attempts > 90) {
            shouldTimeout = true
          }
        } catch {
          shouldTimeout = attempts > 90
        }

        if (shouldTimeout) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setStatus('error')
          setError('Processing timed out. Please try again.')
        }
      }, 2000)
    } catch (err) {
      setStatus('error')
      setError(err.userMessage || 'Something went wrong while processing this document.')
    }
  }

  function handleReset() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setFile(null)
    setStatus('idle')
    setError('')
  }

  const isProcessing = status === 'uploading' || status === 'processing'

  return (
    <div className="relative min-h-full overflow-hidden bg-[#020817]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_14%,rgba(37,99,235,0.2),transparent_30%),radial-gradient(circle_at_78%_18%,rgba(6,182,212,0.16),transparent_28%),linear-gradient(180deg,rgba(15,23,42,0.16),rgba(2,6,23,0.98))]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.035)_1px,transparent_1px)] bg-[size:56px_56px] opacity-55" />

      <main className="relative mx-auto grid max-w-[1440px] gap-8 px-4 py-8 sm:px-6 lg:min-h-[calc(100vh-94px)] lg:grid-cols-[0.75fr_1.25fr] lg:items-center lg:px-10 lg:py-12">
        <section className="max-w-xl">
          <p className="mb-6 text-[14.7px] font-bold text-blue-400">Upload Document</p>
          <h1 className="text-4xl font-black leading-[1.16] tracking-[-0.035em] text-white sm:text-5xl xl:text-[56px]">
            Extract. Verify.
            <span className="block">Understand.</span>
            <span className="block">Delivery challans in</span>
            <span className="block text-blue-400 drop-shadow-[0_0_28px_rgba(59,130,246,0.55)]">seconds.</span>
          </h1>
          <p className="mt-6 max-w-lg text-base leading-8 text-slate-400">
            Upload a Consignor-Consignee delivery challan and AI auto-splits the page, then extracts party details, invoice info, line items, and GST totals instantly.
          </p>
          <LogisticsUploadIllustration />
        </section>

        <section className="rounded-[32px] border border-blue-300/18 bg-slate-900/62 p-5 shadow-[0_34px_120px_rgba(2,8,23,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl sm:p-7">
          {isProcessing ? (
            <UploadProcessingState
              message={status === 'uploading' ? 'Uploading delivery challan...' : 'Splitting page and running OCR + AI analysis...'}
            />
          ) : status === 'done' ? (
            <div className="flex min-h-[460px] flex-col items-center justify-center gap-4 rounded-[26px] border border-emerald-300/18 bg-emerald-400/8 px-5 py-16 text-center">
              <div className="grid h-20 w-20 place-items-center rounded-full border border-emerald-300/25 bg-emerald-400/15 text-[14.7px] font-black text-emerald-200 shadow-[0_0_45px_rgba(16,185,129,0.22)]">Done</div>
              <div>
                <p className="text-xl font-black text-white">Delivery challan processed</p>
                <p className="mt-2 text-[14.7px] text-slate-500">Redirecting to chat...</p>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <UploadCard onFileSelect={handleFileSelect} disabled={isProcessing} />

              {file && <DocumentPreview file={file} />}

              {error && (
                <div className="flex items-start gap-3 rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-[14.7px] text-rose-200">
                  <svg className="mt-0.5 h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              {file && (
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button
                    onClick={handleUpload}
                    disabled={isProcessing}
                    className="flex-1 rounded-2xl bg-gradient-to-r from-blue-600 to-cyan-500 px-5 py-3.5 text-[14.7px] font-black text-white shadow-[0_18px_45px_rgba(37,99,235,0.3)] transition-all hover:-translate-y-0.5 hover:shadow-[0_22px_60px_rgba(37,99,235,0.42)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Upload &amp; Process
                  </button>
                  <button
                    onClick={handleReset}
                    className="rounded-2xl border border-white/10 bg-white/[0.045] px-6 py-3.5 text-[14.7px] font-bold text-slate-300 transition-all hover:border-blue-300/25 hover:bg-blue-500/10 hover:text-white"
                  >
                    Clear
                  </button>
                </div>
              )}

              <GuidelineCard />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
