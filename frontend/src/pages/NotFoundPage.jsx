import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
      <p className="text-7xl font-bold text-gray-800 mb-4">404</p>
      <h1 className="text-2xl font-semibold text-white mb-2">Page not found</h1>
      <p className="text-gray-500 text-sm mb-8">The page you're looking for doesn't exist.</p>
      <Link
        to="/"
        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-colors no-underline"
      >
        Go to Dashboard
      </Link>
    </div>
  )
}
