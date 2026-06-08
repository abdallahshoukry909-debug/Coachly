import type { Review } from '@/lib/types'
import StarRating from './StarRating'

interface ReviewCardProps {
  review: Review
}

export default function ReviewCard({ review }: ReviewCardProps) {
  const reviewer = review.profiles
  const initials = reviewer?.full_name
    ? reviewer.full_name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : '??'

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 font-semibold text-sm flex-shrink-0">
          {initials}
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <p className="font-medium text-gray-900">{reviewer?.full_name ?? 'Anonymous'}</p>
            <span className="text-xs text-gray-400">
              {new Date(review.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          <StarRating rating={review.rating} size="sm" />
        </div>
      </div>
      {review.comment && (
        <p className="text-gray-600 text-sm leading-relaxed">{review.comment}</p>
      )}
    </div>
  )
}
