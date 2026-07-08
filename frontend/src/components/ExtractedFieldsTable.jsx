import { useState } from 'react'

const confidenceColors = {
  high: 'text-green-400',
  medium: 'text-yellow-400',
  low: 'text-red-400',
}

const categoryIcons = {
  gst: 'GST',
  amount: 'Amount',
  date: 'Date',
  id: 'ID',
  tax: 'Tax',
  name: 'Name',
  address: 'Addr',
  default: 'Field',
}

export default function ExtractedFieldsTable({ fields, onCorrect }) {
  const [filter, setFilter] = useState('all')

  if (!fields || fields.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-gray-300 font-semibold mb-2">Extracted Fields</h3>
        <p className="text-gray-500 text-sm">No fields extracted.</p>
      </div>
    )
  }

  const categories = ['all', ...new Set(fields.map(f => f.category).filter(Boolean))]
  const filtered = filter === 'all' ? fields : fields.filter(f => f.category === filter)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-gray-300 font-semibold flex items-center gap-2">
          <span className="text-blue-400">Fields</span> Extracted Fields
          <span className="text-xs text-gray-500 font-normal">({filtered.length})</span>
        </h3>
        <div className="flex gap-1 flex-wrap">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`text-xs px-2 py-0.5 rounded capitalize transition-colors ${
                filter === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900/50">
              <th className="text-left px-4 py-2.5 text-gray-500 font-medium">Field</th>
              <th className="text-left px-4 py-2.5 text-gray-500 font-medium">Value</th>
              <th className="text-left px-4 py-2.5 text-gray-500 font-medium hidden sm:table-cell">Confidence</th>
              {onCorrect && <th className="px-4 py-2.5 text-gray-500 font-medium text-right">Edit</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((field, i) => (
              <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span>{categoryIcons[field.category] || categoryIcons.default}</span>
                    <span className="text-gray-300 font-medium">{field.label}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`font-mono text-sm ${field.value ? 'text-white' : 'text-gray-600 italic'}`}>
                    {field.correctedValue ?? field.value ?? 'N/A'}
                  </span>
                  {field.correctedValue && field.correctedValue !== field.value && (
                    <span className="ml-2 text-xs text-amber-400">(edited)</span>
                  )}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <span className={`text-xs capitalize ${confidenceColors[field.confidence] || 'text-gray-500'}`}>
                    {field.confidence || '-'}
                  </span>
                </td>
                {onCorrect && (
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => onCorrect(field)}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
