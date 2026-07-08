import { Link } from 'react-router-dom'

export default function EmptyState({ icon = 'File', title, description, actionLabel, actionTo }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center px-4">
      <div className="text-5xl">{icon}</div>
      <div>
        <h3 className="text-gray-300 font-semibold text-lg">{title}</h3>
        {description && <p className="text-gray-500 text-sm mt-1">{description}</p>}
      </div>
      {actionLabel && actionTo && (
        <Link
          to={actionTo}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium transition-colors no-underline"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
