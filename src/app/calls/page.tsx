import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CallsClient from './CallsClient'
import type { SalesClient, SalesCall } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function CallsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/auth/login')

  const [{ data: clients }, { data: calls }] = await Promise.all([
    supabase
      .from('sales_clients')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false }),
    supabase
      .from('sales_calls')
      .select('*')
      .eq('user_id', user.id)
      .order('call_date', { ascending: false })
      .order('created_at', { ascending: false }),
  ])

  return (
    <CallsClient
      userId={user.id}
      initialClients={(clients ?? []) as SalesClient[]}
      initialCalls={(calls ?? []) as SalesCall[]}
    />
  )
}
