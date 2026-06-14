import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import LeadsClient from './LeadsClient'
import type { Lead } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function LeadsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .order('company_name', { ascending: true })

  return <LeadsClient initialLeads={(leads ?? []) as Lead[]} />
}
