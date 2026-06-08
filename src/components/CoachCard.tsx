import Link from 'next/link'
import type { Coach } from '@/lib/types'
import StarRating from './StarRating'

interface CoachCardProps {
  coach: Coach
}

export default function CoachCard({ coach }: CoachCardProps) {
  const profile = coach.profiles
  const initials = profile?.full_name
    ? profile.full_name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : '??'

  return (
    <Link href={`/coaches/${coach.id}`} className="block">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4 hover:shadow-md transition-shadow active:scale-[0.99] transition-transform">
        {/* Avatar */}
        <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center text-green-700 font-bold text-lg flex-shrink-0">
          {initials}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-semibold text-gray-900 truncate">{profile?.full_name ?? 'Unknown Coach'}</p>
            {coach.is_verified && (
              <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>
          {coach.category && (
            <span className="text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full font-medium">
              {coach.category}
            </span>
          )}
          <div className="flex items-center gap-2 mt-1">
            <StarRating rating={coach.rating_avg ?? 0} size="sm" />
            <span className="text-xs text-gray-400">
              {coach.rating_avg > 0
                ? `${Number(coach.rating_avg).toFixed(1)} (${coach.total_reviews})`
                : 'New'}
            </span>
          </div>
        </div>

        {/* Price + Arrow */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {coach.price_per_session != null && (
            <span className="font-bold text-gray-900 text-sm">${coach.price_per_session}</span>
          )}
          <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    </Link>
  )
}
