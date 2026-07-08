import { Link } from 'react-router-dom'
import DocumentCard from './DocumentCard'

export default function DocumentList({ documents }) {
  if (!documents || documents.length === 0) {
    return (
      <div className="rounded-[30px] border border-blue-300/12 bg-slate-900/62 p-10 text-center shadow-[0_28px_100px_rgba(2,8,23,0.35)] backdrop-blur-xl">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-blue-300/18 bg-blue-500/10 text-[14.7px] font-black text-blue-200 shadow-[0_0_42px_rgba(37,99,235,0.2)]">DOC</div>
        <h2 className="mt-5 text-2xl font-black text-white">No delivery challans yet</h2>
        <p className="mx-auto mt-2 max-w-md text-[14.7px] leading-6 text-slate-500">
          Upload your first Consignor-Consignee delivery challan to start extracting party details, invoice info, line items, and tax totals.
        </p>
        <Link
          to="/upload"
          className="mt-6 inline-flex rounded-2xl bg-gradient-to-r from-blue-600 to-cyan-500 px-5 py-3 text-[14.7px] font-black text-white no-underline shadow-[0_18px_45px_rgba(37,99,235,0.3)] transition-all hover:-translate-y-0.5"
        >
          Upload Document
        </Link>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      {documents.map((doc) => (
        <DocumentCard key={doc._id} doc={doc} />
      ))}
    </div>
  )
}
