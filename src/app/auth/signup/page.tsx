'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserRole } from '@/lib/types'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<UserRole>('client')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { data, error: signupError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (signupError) {
      setError(signupError.message)
      setLoading(false)
      return
    }

    const userId = data.user?.id
    if (!userId) {
      setError('Signup failed. Please try again.')
      setLoading(false)
      return
    }

    // Insert profile
    const { error: profileError } = await supabase.from('profiles').insert({
      id: userId,
      email,
      full_name: fullName || null,
      role,
    })

    if (profileError) {
      setError(profileError.message)
      setLoading(false)
      return
    }

    // If coach, insert coaches record
    if (role === 'coach') {
      await supabase.from('coaches').insert({
        user_id: userId,
        specialty: [],
      })
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4 bg-gray-50 py-12">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900">Create account</h1>
          <p className="text-gray-600 mt-2">Join Coachly today</p>
        </div>

        <form onSubmit={handleSignup} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Smith"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>

          {/* Role Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">I am a...</label>
            <div className="grid grid-cols-2 gap-3">
              <label
                className={`cursor-pointer rounded-xl border-2 p-4 text-center transition-colors ${
                  role === 'client'
                    ? 'border-green-600 bg-green-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value="client"
                  className="sr-only"
                  checked={role === 'client'}
                  onChange={() => setRole('client')}
                />
                <span className="text-2xl block mb-1">🎯</span>
                <span className={`font-semibold text-sm ${role === 'client' ? 'text-green-700' : 'text-gray-700'}`}>
                  Client
                </span>
                <p className="text-xs text-gray-500 mt-0.5">Find & book coaches</p>
              </label>
              <label
                className={`cursor-pointer rounded-xl border-2 p-4 text-center transition-colors ${
                  role === 'coach'
                    ? 'border-green-600 bg-green-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value="coach"
                  className="sr-only"
                  checked={role === 'coach'}
                  onChange={() => setRole('coach')}
                />
                <span className="text-2xl block mb-1">🏆</span>
                <span className={`font-semibold text-sm ${role === 'coach' ? 'text-green-700' : 'text-gray-700'}`}>
                  Coach
                </span>
                <p className="text-xs text-gray-500 mt-0.5">Offer coaching sessions</p>
              </label>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 text-red-700 text-sm px-3 py-2.5 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition-colors font-semibold disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600 mt-6">
          Already have an account?{' '}
          <Link href="/auth/login" className="text-green-600 font-semibold hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
