import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import api from '../utils/api'
import SummaryCard from '../components/SummaryCard'
import ExtractedFieldsTable from '../components/ExtractedFieldsTable'
import ExtractedTablesView from '../components/ExtractedTablesView'
import CorrectionModal from '../components/CorrectionModal'
import LoadingState from '../components/LoadingState'
import ErrorMessage from '../components/ErrorMessage'
import ProcessingState from '../components/ProcessingState'

function formatDate(d) {
  if (!d) return '-'
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export default function DocumentDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('summary')
  const [correctionField, setCorrectionField] = useState(null)
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessMsg, setReprocessMsg] = useState('')
  const [deleting, setDeleting] = useState(false)

  async function fetchDoc() {
    try {
      const res = await api.get(`/documents/${id}`)
      setDoc(res.data?.document)
    } catch (err) {
      setError(err.userMessage || 'Document not found or could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    api.get(`/documents/${id}`)
      .then(res => {
        if (!cancelled) setDoc(res.data?.document)
      })
      .catch(err => {
        if (!cancelled) setError(err.userMessage || 'Document not found or could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [id])

  async function handleCorrect(field, newValue) {
    try {
      await api.patch(`/documents/${id}/fields/${field.normalizedKey}/correct`, {
        fieldLabel: field.label,
        fieldKey: field.normalizedKey,
        oldValue: field.correctedValue ?? field.value,
        newValue,
      })
      setCorrectionField(null)
      fetchDoc()
    } catch {
      alert('Failed to save correction.')
    }
  }

  async function handleReprocess() {
    if (!window.confirm('Re-run OCR and AI analysis on this document?')) return
    setReprocessing(true)
    setReprocessMsg('')
    try {
      await api.post(`/documents/${id}/reprocess`)
      setReprocessMsg('Reprocessing started. Check the document status shortly.')
      fetchDoc()
    } catch (err) {
      setReprocessMsg(err.userMessage || 'Reprocessing failed.')
    } finally {
      setReprocessing(false)
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this document? This cannot be undone.')) return
    setDeleting(true)
    try {
      await api.delete(`/documents/${id}`)
      navigate('/documents')
    } catch {
      alert('Failed to delete document.')
      setDeleting(false)
    }
  }

  function handleDownload() {
    window.open(`/api/documents/${id}/download`, '_blank')
  }

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-8"><LoadingState /></div>
  if (error) return <div className="max-w-4xl mx-auto px-4 py-8"><ErrorMessage message={error} /></div>
  if (!doc) return null

  const statusColor = {
    uploaded: 'text-yellow-400 bg-yellow-900/20 border-yellow-800',
    processed: 'text-green-400 bg-green-900/20 border-green-800',
    failed: 'text-red-400 bg-red-900/20 border-red-800',
  }[doc.uploadStatus] || 'text-gray-400 bg-gray-800 border-gray-700'

  const tabs = [
    { id: 'summary', label: 'Combined Summary' },
    { id: 'fields', label: 'Fields' },
    { id: 'tables', label: 'Tables' },
    { id: 'part1', label: 'Part 1 - Header' },
    { id: 'part2', label: 'Part 2 - Line Items' },
  ]

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Back */}
      <Link to="/documents" className="text-gray-500 hover:text-gray-300 text-[14.7px] no-underline flex items-center gap-1 mb-4">
        {'<-'} Back to Documents
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{doc.autoName}</h1>
          <p className="text-gray-500 text-[12.6px] mt-0.5">{doc.originalFilename}</p>
        </div>
        <span className={`text-[12.6px] px-2.5 py-1 rounded-full border font-medium capitalize ${statusColor}`}>
          {doc.uploadStatus}
        </span>
      </div>

      {/* Meta */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[14.7px]">
        {[
          { label: 'Document Type', value: doc.documentType || '-' },
          { label: 'File Size', value: formatSize(doc.size) },
          { label: 'Uploaded', value: formatDate(doc.createdAt) },
          { label: 'Processed', value: formatDate(doc.processedAt || doc.reprocessedAt) },
        ].map(m => (
          <div key={m.label}>
            <p className="text-gray-600 text-[12.6px] mb-0.5">{m.label}</p>
            <p className="text-gray-300 text-[14.7px]">{m.value}</p>
          </div>
        ))}
      </div>

      {/* Processing error */}
      {doc.uploadStatus === 'failed' && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-4 mb-5">
          <p className="text-red-400 font-semibold mb-1">Processing Failed</p>
          <p className="text-red-300/70 text-[14.7px]">{doc.processingError || 'Something went wrong while processing this document.'}</p>
        </div>
      )}

      {/* Reprocess feedback */}
      {reprocessMsg && (
        <div className={`border rounded-xl p-3 mb-4 text-[14.7px] ${reprocessMsg.toLowerCase().includes('started') ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-red-900/20 border-red-800 text-red-400'}`}>
          {reprocessMsg}
        </div>
      )}

      {/* Warnings */}
      {doc.warnings?.length > 0 && (
        <div className="bg-yellow-900/10 border border-yellow-800/50 rounded-xl p-4 mb-5">
          <p className="text-yellow-400 font-medium text-[14.7px] mb-2">Warn Extraction Warnings</p>
          <ul className="space-y-1">
            {doc.warnings.map((w, i) => (
              <li key={i} className="text-yellow-300/60 text-[12.6px]">- {w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-6">
        {doc.uploadStatus === 'processed' && (
          <Link
            to={`/documents/${id}/chat`}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-[14.7px] font-medium rounded-lg transition-colors no-underline"
          >
            Chat with Document
          </Link>
        )}
        <button onClick={handleDownload} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-[14.7px] rounded-lg transition-colors">
          Download Original
        </button>
        <button onClick={handleReprocess} disabled={reprocessing} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-[14.7px] rounded-lg transition-colors">
          {reprocessing ? 'Reprocessing...' : 'Reprocess'}
        </button>
        <button onClick={handleDelete} disabled={deleting} className="px-4 py-2 bg-red-900/30 hover:bg-red-900/50 disabled:opacity-50 text-red-400 text-[14.7px] rounded-lg border border-red-800/50 transition-colors">
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>

      {/* Reprocessing spinner */}
      {reprocessing && <ProcessingState message="Reprocessing with OCR and AI..." />}

      {/* Tabs */}
      {doc.uploadStatus === 'processed' && !reprocessing && (
        <>
          <div className="flex gap-0 mb-5 border-b border-gray-800">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-[14.7px] font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'summary' && (
            <SummaryCard
              fullSummary={doc.fullSummary}
              summaryPoints={doc.summaryPoints}
              fields={doc.extractedFields}
              onCorrect={(field) => setCorrectionField(field)}
            />
          )}
          {activeTab === 'fields' && (
            <ExtractedFieldsTable
              fields={doc.extractedFields}
              onCorrect={(field) => setCorrectionField(field)}
            />
          )}
          {activeTab === 'tables' && (
            <ExtractedTablesView
              tables={doc.extractedTables}
              fields={doc.extractedFields}
              onCorrect={(field) => setCorrectionField(field)}
            />
          )}
          {activeTab === 'part1' && (
            <div className="space-y-4">
              <div className="bg-blue-900/10 border border-blue-800/40 rounded-xl p-3 text-[12.6px] text-blue-300/80">
                Part 1 is the upper section of the page: Consignee and Consignor header table.
              </div>
              <SummaryCard fullSummary={doc.part1?.summary} summaryPoints={[]} fields={doc.part1?.fields} onCorrect={(field) => setCorrectionField(field)} />
              <ExtractedFieldsTable fields={doc.part1?.fields} onCorrect={(field) => setCorrectionField(field)} />
            </div>
          )}
          {activeTab === 'part2' && (
            <div className="space-y-4">
              <div className="bg-blue-900/10 border border-blue-800/40 rounded-xl p-3 text-[12.6px] text-blue-300/80">
                Part 2 is the lower section of the page: line-items and GST tax totals table.
              </div>
              <SummaryCard fullSummary={doc.part2?.summary} summaryPoints={[]} fields={[]} onCorrect={null} />
              <ExtractedTablesView tables={doc.part2?.tables} fields={[]} onCorrect={null} />
            </div>
          )}
        </>
      )}

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
