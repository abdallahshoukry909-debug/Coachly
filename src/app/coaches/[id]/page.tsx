import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ReviewCard from '@/components/ReviewCard'
import StarRating from '@/components/StarRating'
import CoachBookingSection from './CoachBookingSection'

export const dynamic = 'force-dynamic'

export default async function CoachProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: coach, error } = await supabase
    .from('coaches')
    .select('*, profiles(*)')
    .eq('id', id)
    .single()

  if (error || !coach) notFound()

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*, profiles(*)')
    .eq('coach_id', id)
    .order('created_at', { ascending: false })

  const { data: { user } } = await supabase.auth.getUser()
  const { data: clientProfile } = user
    ? await supabase.from('profiles').select('role').eq('id', user.id).single()
    : { data: null }

  const profile = coach.profiles
  const reviewsList = reviews ?? []

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      {/* Profile Header */}
      <div className="bg-white rounded-2xl border border-gray-200 p-8 mb-6">
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="w-24 h-24 rounded-2xl bg-green-100 flex items-center justify-center text-green-700 font-bold text-3xl flex-shrink-0">
            {profile?.full_name
              ? profile.full_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
              : '??'}
          </div>
          <div className="flex-1">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold text-gray-900">{profile?.full_name ?? 'Unknown'}</h1>
                  {coach.is_verified && (
                    <span className="bg-green-100 text-green-700 text-sm px-2.5 py-0.5 rounded-full font-medium">
                      Verified
                    </span>
                  )}
                </div>
                {coach.category && (
                  <span className="inline-block bg-green-50 text-green-700 border border-green-200 text-sm px-3 py-0.5 rounded-full mt-1">
                    {coach.category}
                  </span>
                )}
                {coach.location && (
                  <p className="text-gray-500 mt-2 flex items-center gap-1.5 text-sm">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {coach.location}
                  </p>
                )}
              </div>
              {coach.price_per_session != null && (
                <div className="text-right">
                  <p className="text-2xl font-bold text-gray-900">${coach.price_per_session}</p>
                  <p className="text-gray-500 text-sm">per session</p>
                </div>
              )}
            </div>

            {reviewsList.length > 0 && (
              <div className="flex items-center gap-2 mt-3">
                <StarRating rating={coach.rating_avg ?? 0} size="md" />
                <span className="text-gray-600 text-sm">
                  {Number(coach.rating_avg).toFixed(1)} ({coach.total_reviews} review{coach.total_reviews !== 1 ? 's' : ''})
                </span>
              </div>
            )}

            {coach.years_experience != null && (
              <p className="text-sm text-gray-500 mt-2">
                {coach.years_experience} year{coach.years_experience !== 1 ? 's' : ''} of experience
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {profile?.bio && (
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-900 mb-3">About</h2>
              <p className="text-gray-600 leading-relaxed">{profile.bio}</p>
            </div>
          )}

          {/* Reviews */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-4">
              Reviews {reviewsList.length > 0 && `(${reviewsList.length})`}
            </h2>
            {reviewsList.length > 0 ? (
              <div className="flex flex-col gap-4">
                {reviewsList.map((review) => (
                  <ReviewCard key={review.id} review={review} />
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-sm">No reviews yet. Be the first!</p>
            )}
          </div>
        </div>

        {/* Booking sidebar */}
        <div className="lg:col-span-1">
          <CoachBookingSection
            coach={coach}
            userId={user?.id ?? null}
            isClient={clientProfile?.role === 'client'}
          />
        </div>
      </div>
    </div>
  )
}
