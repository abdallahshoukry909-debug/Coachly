'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import BottomNav from './BottomNav'
import type { User } from '@supabase/supabase-js'

const AUTH_PATHS = ['/auth/login', '/auth/signup', '/auth/callback']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [user, setUser] = useState<User | null>(null)
  const supabase = createClient()

  const isAuthPage = AUTH_PATHS.some((p) => pathname.startsWith(p))

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  return (
    <>
      <main className={`max-w-lg mx-auto min-h-screen ${!isAuthPage && user ? 'pb-20' : ''}`}>
        {children}
      </main>
      {!isAuthPage && user && <BottomNav />}
    </>
  )
}
