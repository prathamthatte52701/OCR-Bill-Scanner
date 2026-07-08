import { useState } from 'react'

export default function CorrectionModal({ field, onSave, onClose }) {
  const [value, setValue] = useState(field?.correctedValue ?? field?.value ?? '')
  const [saving, setSaving] = useState(false)

  if (!field) return null

  async function handleSave() {
    if (!value.trim()) return
    setSaving(true)
    await onSave(field, value.trim())
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-white font-semibold">Edit Field Value</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <p className="text-gray-500 text-xs mb-1">Field</p>
            <p className="text-gray-200 font-medium">{field.label}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Original Value</p>
            <p className="text-gray-400 text-sm font-mono">{field.value || 'N/A'}</p>
          </div>
          <div>
            <label className="text-gray-500 text-xs mb-1 block">New Value</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="Enter corrected value"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
          </div>
        </div>

        <div className="px-5 pb-5 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !value.trim()}
            className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {saving ? 'Saving...' : 'Save Correction'}
          </button>
        </div>
      </div>
    </div>
  )
}
