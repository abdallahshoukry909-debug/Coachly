import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import StarRating from '@/components/StarRating'

export const dynamic = 'force-dynamic'

const statusConfig = {
  pending: { label: 'Pending', classes: 'bg-yellow-100 text-yellow-800' },
  accepted: { label: 'Accepted', classes: 'bg-blue-100 text-blue-800' },
  completed: { label: 'Completed', classes: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelled', classes: 'bg-red-100 text-red-800' },
}

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/auth/login')

  const { data: session, error } = await supabase
    .from('sessions')
    .select(`
      *,
      coaches (
        *,
        profiles (*)
      ),
      profiles (*)
    `)
    .eq('id', id)
    .single()

  if (error || !session) notFound()

  // Auth check - only participants can see
  const coachUserId = session.coaches?.profiles?.id
  if (session.client_id !== user.id && coachUserId !== user.id) {
    redirect('/sessions')
  }

  const { data: review } = await supabase
    .from('reviews')
    .select('*')
    .eq('session_id', id)
    .single()

  const status = statusConfig[session.status as keyof typeof statusConfig]
  const coach = session.coaches
  const coachProfile = coach?.profiles
  const clientProfile = session.profiles
  const scheduledDate = new Date(session.scheduled_at)

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="mb-6">
        <Link href="/sessions" className="text-green-600 hover:underline text-sm flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Sessions
        </Link>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Session Details</h1>
          <span className={`text-sm font-medium px-3 py-1.5 rounded-full ${status.classes}`}>
            {status.label}
          </span>
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center text-green-700 font-bold">
              {coachProfile?.full_name
                ? coachProfile.full_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
                : '??'}
            </div>
            <div>
              <p className="text-xs text-gray-500">Coach</p>
              <p className="font-semibold text-gray-900">{coachProfile?.full_name ?? 'Unknown'}</p>
              {coach?.specialty && coach.specialty.length > 0 && (
                <p className="text-xs text-gray-500">{coach.specialty.slice(0, 2).join(', ')}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold">
              {clientProfile?.full_name
                ? clientProfile.full_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
                : '??'}
            </div>
            <div>
              <p className="text-xs text-gray-500">Client</p>
              <p className="font-semibold text-gray-900">{clientProfile?.full_name ?? 'Unknown'}</p>
            </div>
          </div>

          <hr className="border-gray-100" />

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500 mb-0.5">Date</p>
              <p className="font-medium text-gray-900">
                {scheduledDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
            <div>
              <p className="text-gray-500 mb-0.5">Time</p>
              <p className="font-medium text-gray-900">
                {scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <div>
              <p className="text-gray-500 mb-0.5">Duration</p>
              <p className="font-medium text-gray-900">{session.duration_minutes} minutes</p>
            </div>
            {session.price != null && (
              <div>
                <p className="text-gray-500 mb-0.5">Price</p>
                <p className="font-medium text-gray-900">${session.price}</p>
              </div>
            )}
          </div>

          {session.notes && (
            <div>
              <p className="text-gray-500 text-sm mb-1">Session Notes</p>
              <p className="text-gray-700 bg-gray-50 rounded-lg p-3 text-sm italic">&ldquo;{session.notes}&rdquo;</p>
            </div>
          )}

          {review && (
            <div>
              <p className="text-gray-500 text-sm mb-2">Review</p>
              <div className="bg-yellow-50 rounded-lg p-4">
                <StarRating rating={review.rating} size="sm" />
                {review.comment && (
                  <p className="text-gray-700 text-sm mt-2">{review.comment}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
