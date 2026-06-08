import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import SessionsClient from './SessionsClient'

export const dynamic = 'force-dynamic'

export default async function SessionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  // Fetch sessions - clients see sessions they booked, coaches see sessions booked with them
  let sessions
  if (profile?.role === 'client') {
    const { data } = await supabase
      .from('sessions')
      .select(`
        *,
        coaches (
          *,
          profiles (*)
        )
      `)
      .eq('client_id', user.id)
      .order('scheduled_at', { ascending: false })
    sessions = data
  } else {
    // Coach: find their coach record first
    const { data: coachRecord } = await supabase
      .from('coaches')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (coachRecord) {
      const { data } = await supabase
        .from('sessions')
        .select(`
          *,
          profiles (*)
        `)
        .eq('coach_id', coachRecord.id)
        .order('scheduled_at', { ascending: false })
      sessions = data
    }
  }

  // Get existing reviews for this user to know which sessions already have reviews
  const { data: existingReviews } = await supabase
    .from('reviews')
    .select('session_id')
    .eq('reviewer_id', user.id)

  const reviewedSessionIds = new Set((existingReviews ?? []).map((r) => r.session_id))

  return (
    <SessionsClient
      sessions={sessions ?? []}
      userId={user.id}
      role={profile?.role ?? 'client'}
      reviewedSessionIds={Array.from(reviewedSessionIds)}
    />
  )
}
