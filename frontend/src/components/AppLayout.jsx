import { Outlet, NavLink } from 'react-router-dom'
import { useState } from 'react'

const navLinks = [
  { to: '/', label: 'Dashboard', exact: true },
  { to: '/upload', label: 'Upload' },
  { to: '/documents', label: 'My Documents' },
]

export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="min-h-screen bg-[#020817] text-slate-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-blue-400/10 bg-slate-950/72 backdrop-blur-xl shadow-[0_14px_40px_rgba(2,8,23,0.28)]">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-10">
          <NavLink to="/" className="group flex items-center gap-3 text-white no-underline">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-blue-400/30 bg-blue-500/15 text-[14.7px] font-black text-blue-200 shadow-[0_0_28px_rgba(37,99,235,0.35)] transition-colors group-hover:border-cyan-300/50">
              TI
            </span>
            <span className="leading-tight">
              <span className="block text-base font-bold tracking-tight">ChallanIntel AI</span>
              <span className="block text-[10.5px] font-medium uppercase tracking-[0.22em] text-slate-500">Delivery Challan Command Center</span>
            </span>
          </NavLink>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 rounded-full border border-white/8 bg-white/[0.035] p-1 md:flex">
            {navLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.exact}
                className={({ isActive }) =>
                  `relative rounded-full px-4 py-2 text-[14.7px] font-semibold transition-all no-underline ${
                    isActive
                      ? 'bg-blue-500/15 text-blue-100 shadow-[inset_0_-1px_0_rgba(96,165,250,0.55),0_0_24px_rgba(37,99,235,0.18)]'
                      : 'text-slate-400 hover:bg-white/[0.045] hover:text-slate-100'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <button
              type="button"
              aria-label="Notifications"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.035] text-slate-400 transition-colors hover:border-blue-300/30 hover:text-blue-100"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              </svg>
            </button>
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-1 pr-3">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 text-[12.6px] font-bold text-white">BO</span>
              <span className="text-[12.6px] font-semibold text-slate-300">Business Owner</span>
            </div>
          </div>

          {/* Mobile menu button */}
          <button
            className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-slate-300 transition-colors hover:text-white md:hidden"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Toggle menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              }
            </svg>
          </button>
        </div>

        {/* Mobile nav */}
        {menuOpen && (
          <div className="flex flex-col gap-1 border-t border-blue-400/10 bg-slate-950/95 px-4 py-3 md:hidden">
            {navLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.exact}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-[14.7px] font-semibold transition-colors no-underline ${
                    isActive
                      ? 'bg-blue-500/15 text-blue-100'
                      : 'text-slate-400 hover:bg-white/[0.045] hover:text-white'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-blue-400/10 bg-slate-950/80 py-3 text-center text-[12.6px] text-slate-600">
        ChallanIntel AI - Consignor/Consignee Delivery Challan Intelligence
      </footer>
    </div>
  )
}
