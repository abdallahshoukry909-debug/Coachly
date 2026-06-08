import type { Session } from '@/lib/types'

interface SessionCardProps {
  session: Session
  onLeaveReview?: (session: Session) => void
}

const statusConfig = {
  pending: { label: 'Pending', classes: 'bg-yellow-100 text-yellow-800' },
  confirmed: { label: 'Confirmed', classes: 'bg-blue-100 text-blue-800' },
  completed: { label: 'Completed', classes: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelled', classes: 'bg-red-100 text-red-800' },
}

export default function SessionCard({ session, onLeaveReview }: SessionCardProps) {
  const coach = session.coaches
  const coachProfile = coach?.profiles
  const scheduledDate = new Date(session.scheduled_at)
  const status = statusConfig[session.status]

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-700 font-bold text-sm">
            {coachProfile?.full_name
              ? coachProfile.full_name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
              : '??'}
          </div>
          <div>
            <p className="font-medium text-gray-900">
              {coachProfile?.full_name ?? 'Unknown Coach'}
            </p>
            {coach?.specialty && coach.specialty.length > 0 && (
              <p className="text-xs text-gray-500">{coach.specialty.slice(0, 2).join(', ')}</p>
            )}
          </div>
        </div>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${status.classes}`}>
          {status.label}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 text-sm text-gray-600 mb-4">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          {scheduledDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ({session.duration_minutes} min)
        </div>
        {session.price != null && (
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            ${session.price}
          </div>
        )}
      </div>

      {session.notes && (
        <p className="text-sm text-gray-500 bg-gray-50 rounded-lg p-2.5 mb-3 italic">
          &ldquo;{session.notes}&rdquo;
        </p>
      )}

      {session.status === 'completed' && onLeaveReview && (
        <button
          onClick={() => onLeaveReview(session)}
          className="w-full text-center bg-green-600 text-white py-2 rounded-lg hover:bg-green-700 transition-colors font-medium text-sm"
        >
          Leave a Review
        </button>
      )}
    </div>
  )
}
