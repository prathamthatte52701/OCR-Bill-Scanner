import SummaryCard from './SummaryCard'
import ExtractedFieldsTable from './ExtractedFieldsTable'
import ExtractedTablesView from './ExtractedTablesView'

const DETAIL_VIEWS = [
  { id: 'summary1', label: 'Full Summary (Part 1)' },
  { id: 'consignee', label: 'Consignee Details' },
  { id: 'consigner', label: 'Consigner Details' },
  { id: 'summary2', label: 'Full Summary (Part 2)' },
  { id: 'items', label: 'Uncoded RGP' },
  { id: 'taxes', label: 'Taxes' },
]

// Part 1 page: its own full summary plus party/header info. Part 2 page: its
// own full summary plus line-items/tax info. Each part's summary is generated
// independently (doc.part1.summary / doc.part2.summary) so it only reflects
// that part's own extracted data - no combined/whole-document view anymore.
const PART_VIEW_IDS = {
  part1: ['summary1', 'consignee', 'consigner'],
  part2: ['summary2', 'taxes', 'items'],
}

// "Consignee Details" also includes challan-level metadata (Invoice No, FI Doc,
// Date, Reason) and "Consigner Details" includes PO/Request/IRN No, matching how
// the user wants these two buttons grouped - not a strict party-only split.
const CONSIGNEE_EXTRA_KEYS = ['invoice_no', 'fi_doc', 'challan_date', 'reason']
const CONSIGNER_EXTRA_KEYS = ['po_no', 'request_no', 'irn_no']

function filterFields(fields, prefix, extraKeys) {
  return (fields || []).filter(f =>
    f.normalizedKey?.startsWith(prefix) || extraKeys.includes(f.normalizedKey)
  )
}

// Renders the content for one detail view. Always reads live from `doc`, so
// every appended chat entry (past or present) reflects the current field
// values - there's no separate stale snapshot to fall out of sync.
export function DetailView({ type, doc, onCorrect }) {
  if (!doc) return null
  const fields = doc.extractedFields || []

  if (type === 'summary1') {
    return (
      <SummaryCard
        fullSummary={doc.part1?.summary}
        summaryPoints={[]}
        fields={doc.part1?.fields || fields}
        onCorrect={onCorrect}
      />
    )
  }
  if (type === 'summary2') {
    return (
      <SummaryCard
        fullSummary={doc.part2?.summary}
        summaryPoints={[]}
        fields={doc.part2?.fields || fields}
        onCorrect={onCorrect}
      />
    )
  }
  if (type === 'consignee') {
    return <ExtractedFieldsTable fields={filterFields(fields, 'consignee_', CONSIGNEE_EXTRA_KEYS)} onCorrect={onCorrect} />
  }
  if (type === 'consigner') {
    return <ExtractedFieldsTable fields={filterFields(fields, 'consignor_', CONSIGNER_EXTRA_KEYS)} onCorrect={onCorrect} />
  }
  if (type === 'items') {
    const itemsAndTaxTables = (doc.extractedTables || []).filter(t => t.title === 'Line Items' || t.title === 'Totals')
    return <ExtractedTablesView tables={itemsAndTaxTables} fields={fields} onCorrect={onCorrect} />
  }
  if (type === 'taxes') {
    const taxTables = (doc.extractedTables || []).filter(t => t.title === 'Totals')
    return <ExtractedTablesView tables={taxTables} fields={fields} onCorrect={onCorrect} />
  }
  return null
}

// Button row only - clicking a button no longer toggles content inline here;
// the parent appends the result to the chat history instead (see onSelect).
// `part` ('part1' | 'part2' | undefined) restricts which buttons show, so the
// Part 1 and Part 2 chat pages each surface only their own relevant actions.
export default function DocumentDetailsPanel({ doc, onSelect, part }) {
  if (!doc || doc.uploadStatus !== 'processed') return null

  const allowedIds = part ? PART_VIEW_IDS[part] : null
  const views = allowedIds ? DETAIL_VIEWS.filter(v => allowedIds.includes(v.id)) : DETAIL_VIEWS

  return (
    <div className="border-t border-blue-300/12 bg-slate-950/68">
      <div className="flex flex-wrap gap-2 px-4 py-3">
        {views.map(v => (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id, v.label)}
            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-blue-300/14 bg-slate-900/70 px-3 py-2 text-[12.6px] font-semibold text-blue-100/75 transition-all hover:border-blue-300/38 hover:bg-blue-500/10 hover:text-blue-100"
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  )
}
