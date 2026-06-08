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
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow flex flex-col gap-4">
      {/* Avatar + Name */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center text-green-700 font-bold text-lg flex-shrink-0">
          {initials}
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 truncate">
            {profile?.full_name ?? 'Unknown Coach'}
          </h3>
          {coach.category && (
            <span className="inline-block bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium mt-0.5">
              {coach.category}
            </span>
          )}
        </div>
        {coach.is_verified && (
          <span className="ml-auto bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full font-medium flex-shrink-0">
            ✓
          </span>
        )}
      </div>

      {/* Location */}
      {coach.location && (
        <p className="text-gray-500 text-sm flex items-center gap-1.5 -mt-1">
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {coach.location}
        </p>
      )}

      {/* Bio snippet */}
      {profile?.bio && (
        <p className="text-gray-600 text-sm line-clamp-2">{profile.bio}</p>
      )}

      {/* Rating + Price */}
      <div className="flex items-center justify-between mt-auto pt-2 border-t border-gray-100">
        <div className="flex items-center gap-1.5">
          <StarRating rating={coach.rating_avg ?? 0} size="sm" />
          <span className="text-xs text-gray-500">
            {coach.rating_avg > 0
              ? `${Number(coach.rating_avg).toFixed(1)} (${coach.total_reviews})`
              : 'New'}
          </span>
        </div>
        {coach.price_per_session != null && (
          <span className="font-semibold text-gray-900 text-sm">
            ${coach.price_per_session}<span className="text-gray-500 font-normal text-xs">/session</span>
          </span>
        )}
      </div>

      <Link
        href={`/coaches/${coach.id}`}
        className="block text-center bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 transition-colors font-medium text-sm"
      >
        View Profile
      </Link>
    </div>
  )
}
