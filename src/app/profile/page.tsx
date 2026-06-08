import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ProfileClient from './ProfileClient'

export const dynamic = 'force-dynamic'

export default async function ProfilePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  let coachData = null
  if (profile?.role === 'coach') {
    const { data } = await supabase
      .from('coaches')
      .select('*')
      .eq('user_id', user.id)
      .single()
    coachData = data
  }

  return <ProfileClient profile={profile} coachData={coachData} />
}
