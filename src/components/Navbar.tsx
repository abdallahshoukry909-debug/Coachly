'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

export default function Navbar() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl font-bold text-green-600">Coachly</span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-6">
            <Link href="/" className="text-gray-600 hover:text-green-600 transition-colors font-medium">
              Home
            </Link>
            <Link href="/coaches" className="text-gray-600 hover:text-green-600 transition-colors font-medium">
              Find Coaches
            </Link>
            {!loading && user && (
              <>
                <Link href="/sessions" className="text-gray-600 hover:text-green-600 transition-colors font-medium">
                  My Sessions
                </Link>
                <Link href="/profile" className="text-gray-600 hover:text-green-600 transition-colors font-medium">
                  Profile
                </Link>
                <button
                  onClick={handleSignOut}
                  className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors font-medium"
                >
                  Sign Out
                </button>
              </>
            )}
            {!loading && !user && (
              <>
                <Link href="/auth/login" className="text-gray-600 hover:text-green-600 transition-colors font-medium">
                  Login
                </Link>
                <Link
                  href="/auth/signup"
                  className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors font-medium"
                >
                  Sign Up
                </Link>
              </>
            )}
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2 rounded-md text-gray-600 hover:text-green-600"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden pb-4 flex flex-col gap-3">
            <Link href="/" className="text-gray-600 hover:text-green-600 py-1" onClick={() => setMenuOpen(false)}>Home</Link>
            <Link href="/coaches" className="text-gray-600 hover:text-green-600 py-1" onClick={() => setMenuOpen(false)}>Find Coaches</Link>
            {!loading && user && (
              <>
                <Link href="/sessions" className="text-gray-600 hover:text-green-600 py-1" onClick={() => setMenuOpen(false)}>My Sessions</Link>
                <Link href="/profile" className="text-gray-600 hover:text-green-600 py-1" onClick={() => setMenuOpen(false)}>Profile</Link>
                <button onClick={handleSignOut} className="text-left text-red-600 py-1">Sign Out</button>
              </>
            )}
            {!loading && !user && (
              <>
                <Link href="/auth/login" className="text-gray-600 hover:text-green-600 py-1" onClick={() => setMenuOpen(false)}>Login</Link>
                <Link href="/auth/signup" className="text-green-600 font-semibold py-1" onClick={() => setMenuOpen(false)}>Sign Up</Link>
              </>
            )}
          </div>
        )}
      </div>
    </nav>
  )
}
