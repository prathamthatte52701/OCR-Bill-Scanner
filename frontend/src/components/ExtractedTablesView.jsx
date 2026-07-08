function buildFieldsByLabel(fields = []) {
  const map = {}
  fields.forEach(f => {
    if (f?.label) map[f.label.toLowerCase()] = f
  })
  return map
}

function findFieldForCell(tableTitle, row, col, fieldsByLabel, rowIndex) {
  if (!fieldsByLabel) return null

  // Totals table rows: { Field: 'CGST', Value: '0.00' }
  if (tableTitle === 'Totals' && col === 'Value') {
    return fieldsByLabel[row.Field?.toLowerCase()] || null
  }

  // Parties table rows: { Role: 'Consignor', Name: '...', GSTIN: '...', PAN: '...' }
  if (tableTitle === 'Parties' && col !== 'Role') {
    const role = row.Role || ''
    const colToLabel = {
      'Name': `${role} Name`,
      'GSTIN': `${role} GSTIN`,
      'PAN': `${role} PAN`,
    }
    return fieldsByLabel[(colToLabel[col] || '').toLowerCase()] || null
  }

  // Line Items table rows: { 'SR No': '2', Description: '...', ... } - backend labels
  // each cell "Item <row-position> - <Column>" (e.g. "Item 1 - Description"),
  // where row-position is the row's 1-based position in the table (not its SR No).
  if (tableTitle === 'Line Items') {
    if (rowIndex === undefined) return null
    return fieldsByLabel[`item ${rowIndex + 1} - ${col}`.toLowerCase()] || null
  }

  return fieldsByLabel[col.toLowerCase()] || null
}

export default function ExtractedTablesView({ tables, fields, onCorrect }) {
  const fieldsByLabel = buildFieldsByLabel(fields)

  if (!tables || tables.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-gray-300 font-semibold mb-2">Extracted Tables</h3>
        <p className="text-gray-500 text-sm">No tables found in this document.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {tables.map((table, ti) => (
        <div key={ti} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <h3 className="text-gray-300 font-semibold flex items-center gap-2">
              <span className="text-blue-400">Table</span>
              {table.title || `Table ${ti + 1}`}
            </h3>
          </div>
          {table.sourceHint && (
            <p className="px-4 py-2 text-xs text-gray-600 border-b border-gray-800">{table.sourceHint}</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-800/50">
                  {(table.columns || []).map((col, ci) => (
                    <th key={ci} className="text-left px-4 py-2.5 text-gray-400 font-medium whitespace-nowrap border-b border-gray-800">
                      {col}
                    </th>
                  ))}
                  {onCorrect && <th className="px-4 py-2.5 text-gray-500 font-medium text-right border-b border-gray-800">Edit</th>}
                </tr>
              </thead>
              <tbody>
                {(table.rows || []).map((row, ri) => (
                  <tr key={ri} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    {(table.columns || []).map((col, ci) => {
                      const cellField = findFieldForCell(table.title, row, col, fieldsByLabel, ri)
                      const displayVal = cellField?.correctedValue ?? row[col] ?? '-'
                      const isEdited = cellField?.correctedValue && cellField.correctedValue !== cellField.value
                      return (
                        <td key={ci} className="px-4 py-2.5 text-gray-300 whitespace-nowrap">
                          {displayVal}
                          {isEdited && <span className="ml-1.5 text-xs text-amber-400">(edited)</span>}
                        </td>
                      )
                    })}
                    {onCorrect && (
                      <td className="px-4 py-2.5 text-right">
                        {(table.columns || []).map((col) => {
                          const cellField = findFieldForCell(table.title, row, col, fieldsByLabel, ri)
                          if (!cellField || col === 'Role') return null
                          return (
                            <button
                              key={col}
                              onClick={() => onCorrect(cellField)}
                              className="ml-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                              title={`Edit ${col}`}
                            >
                              ✏ {col}
                            </button>
                          )
                        })}
                      </td>
                    )}
                  </tr>
                ))}
                {(!table.rows || table.rows.length === 0) && (
                  <tr>
                    <td colSpan={(table.columns?.length || 1) + (onCorrect ? 1 : 0)} className="px-4 py-4 text-center text-gray-600 text-sm">
                      No rows found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
