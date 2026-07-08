export default function SummaryCard({ fullSummary, summaryPoints, fields, onCorrect }) {
  const hasFullSummary = fullSummary && fullSummary.trim().length > 0
  const hasLegacy = !hasFullSummary && summaryPoints && summaryPoints.length > 0

  // Build label→field map for edit lookups
  const fieldsByLabel = {}
  if (fields) {
    fields.forEach(f => {
      if (f?.label) fieldsByLabel[f.label.toLowerCase()] = f
    })
  }

  if (!hasFullSummary && !hasLegacy) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="text-gray-300 font-semibold mb-2 flex items-center gap-2">
          <span className="text-blue-400">Summary</span> Document Overview
        </h3>
        <p className="text-gray-500 text-sm">Summary not available. Click <strong className="text-gray-400">Reprocess</strong> above to generate it.</p>
      </div>
    )
  }

  function renderStructured(text) {
    const lines = text.split('\n')
    return lines.map((line, i) => {
      const trimmed = line.trim()
      if (!trimmed) return <div key={i} className="h-2" />

      const isHeader = /^[A-Z][A-Z\s&/]+:/.test(trimmed)
      const isBullet = trimmed.startsWith('-')
      const isKeyValue = trimmed.includes(':') && !isHeader && !isBullet

      if (isHeader) {
        return (
          <div key={i} className="mt-4 mb-1 text-blue-400 text-xs font-bold uppercase tracking-wider">
            {trimmed}
          </div>
        )
      }
      if (isBullet) {
        return (
          <div key={i} className="flex gap-2 text-sm text-gray-300 leading-relaxed pl-2">
            <span className="text-blue-500 flex-shrink-0">-</span>
            <span>{trimmed.replace(/^-+\s*/, '')}</span>
          </div>
        )
      }
      if (isKeyValue) {
        const colonIdx = trimmed.indexOf(':')
        const label = trimmed.slice(0, colonIdx).trim()
        const value = trimmed.slice(colonIdx + 1).trim()
        const field = fieldsByLabel[label.toLowerCase()]
        const displayValue = field?.correctedValue ?? value
        const isEdited = field?.correctedValue && field.correctedValue !== field.value
        return (
          <div key={i} className="flex gap-2 text-sm leading-relaxed items-center group">
            <span className="text-gray-500 flex-shrink-0 min-w-[120px]">{label}:</span>
            <span className="text-gray-200">{displayValue}</span>
            {isEdited && <span className="text-xs text-amber-400">(edited)</span>}
            {field && onCorrect && (
              <button
                onClick={() => onCorrect(field)}
                className="text-blue-400 hover:text-blue-300 opacity-0 group-hover:opacity-100 transition-opacity text-xs ml-1 flex-shrink-0"
                title={`Edit ${label}`}
              >
                ✏
              </button>
            )}
          </div>
        )
      }
      return (
        <div key={i} className="text-sm text-gray-300 leading-relaxed">{trimmed}</div>
      )
    })
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h3 className="text-gray-300 font-semibold mb-3 flex items-center gap-2">
        <span className="text-blue-400">Summary</span> Document Overview
        <span className="ml-auto text-xs text-gray-600 font-normal">Complete extraction - all details</span>
      </h3>

      {hasFullSummary ? (
        <div className="space-y-0.5">
          {renderStructured(fullSummary)}
        </div>
      ) : (
        <ul className="space-y-2">
          {summaryPoints.map((point, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-gray-300">
              <span className="text-blue-500 flex-shrink-0 mt-0.5 font-medium">{i + 1}.</span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
