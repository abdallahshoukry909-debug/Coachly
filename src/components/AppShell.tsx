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
  const [role, setRole] = useState<string | null>(null)
  const supabase = createClient()

  const isAuthPage = AUTH_PATHS.some((p) => pathname.startsWith(p))

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      setUser(user)
      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single()
        setRole(data?.role ?? null)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        const { data } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', session.user.id)
          .single()
        setRole(data?.role ?? null)
      } else {
        setRole(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  return (
    <>
      <main className={`max-w-lg mx-auto min-h-screen ${!isAuthPage && user ? 'pb-20' : ''}`}>
        {children}
      </main>
      {!isAuthPage && user && <BottomNav role={role} />}
    </>
  )
}
