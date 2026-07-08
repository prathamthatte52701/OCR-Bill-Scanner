export default function ProcessingState({ message = 'Processing document...' }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center px-4">
      <div className="relative w-16 h-16">
        <div className="w-16 h-16 border-2 border-gray-700 rounded-full" />
        <div className="absolute inset-0 w-16 h-16 border-2 border-t-blue-500 border-r-blue-400 rounded-full animate-spin" />
        <div className="absolute inset-3 flex items-center justify-center">
          <span className="text-xl">File</span>
        </div>
      </div>
      <div>
        <p className="text-white font-medium">{message}</p>
        <p className="text-gray-500 text-sm mt-1">This may take a few moments.</p>
      </div>
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  )
}
