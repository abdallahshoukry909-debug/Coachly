'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import StarRating from '@/components/StarRating'
import type { Session, SessionStatus } from '@/lib/types'

interface SessionsClientProps {
  sessions: Session[]
  userId: string
  role: string
  reviewedSessionIds: string[]
}

const statusConfig: Record<SessionStatus, { label: string; classes: string }> = {
  pending: { label: 'Pending', classes: 'bg-yellow-100 text-yellow-800' },
  accepted: { label: 'Accepted', classes: 'bg-blue-100 text-blue-800' },
  completed: { label: 'Completed', classes: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelled', classes: 'bg-red-100 text-red-800' },
}

export default function SessionsClient({ sessions: initialSessions, userId, role, reviewedSessionIds }: SessionsClientProps) {
  const [sessions, setSessions] = useState(initialSessions)
  const [reviewSession, setReviewSession] = useState<Session | null>(null)
  const [rating, setRating] = useState(5)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [reviewed, setReviewed] = useState<Set<string>>(new Set(reviewedSessionIds))

  const supabase = createClient()

  async function updateSessionStatus(sessionId: string, status: SessionStatus) {
    setActionLoading(sessionId)
    const { error } = await supabase
      .from('sessions')
      .update({ status })
      .eq('id', sessionId)
    setActionLoading(null)
    if (!error) {
      setSessions((prev) => prev.map((s) => s.id === sessionId ? { ...s, status } : s))
    }
  }

  async function handleSubmitReview(e: React.FormEvent) {
    e.preventDefault()
    if (!reviewSession) return
    setSubmitting(true)
    setError('')

    const { error: reviewError } = await supabase.from('reviews').insert({
      session_id: reviewSession.id,
      reviewer_id: userId,
      coach_id: reviewSession.coach_id,
      rating,
      comment: comment || null,
    })

    setSubmitting(false)
    if (reviewError) {
      setError(reviewError.message)
    } else {
      setReviewed((prev) => new Set([...prev, reviewSession.id]))
      setReviewSession(null)
      setRating(5)
      setComment('')
    }
  }

  const pending = sessions.filter((s) => s.status === 'pending')
  const accepted = sessions.filter((s) => s.status === 'accepted')
  const completed = sessions.filter((s) => s.status === 'completed')
  const cancelled = sessions.filter((s) => s.status === 'cancelled')

  function SessionCard({ session }: { session: Session }) {
    const isCoach = role === 'coach'
    const coachProfile = session.coaches?.profiles
    const clientProfile = session.profiles
    const scheduledDate = new Date(session.scheduled_at)
    const status = statusConfig[session.status]
    const isLoading = actionLoading === session.id

    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-700 font-bold text-sm flex-shrink-0">
              {isCoach
                ? clientProfile?.full_name?.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2) ?? '??'
                : coachProfile?.full_name?.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2) ?? '??'}
            </div>
            <div>
              <p className="font-medium text-gray-900 text-sm">
                {isCoach ? clientProfile?.full_name ?? 'Client' : coachProfile?.full_name ?? 'Coach'}
              </p>
              {!isCoach && session.coaches?.category && (
                <p className="text-xs text-gray-500">{session.coaches.category}</p>
              )}
            </div>
          </div>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${status.classes}`}>
            {status.label}
          </span>
        </div>

        <div className="flex flex-col gap-1 text-sm text-gray-600 mb-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {scheduledDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · {session.duration_minutes} min
          </div>
          {session.price != null && (
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

        {/* Coach actions */}
        {isCoach && session.status === 'pending' && (
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => updateSessionStatus(session.id, 'accepted')}
              disabled={isLoading}
              className="flex-1 bg-green-600 text-white text-sm py-2 rounded-lg hover:bg-green-700 transition-colors font-medium disabled:opacity-50"
            >
              {isLoading ? '...' : 'Accept'}
            </button>
            <button
              onClick={() => updateSessionStatus(session.id, 'cancelled')}
              disabled={isLoading}
              className="flex-1 border border-red-300 text-red-600 text-sm py-2 rounded-lg hover:bg-red-50 transition-colors font-medium disabled:opacity-50"
            >
              {isLoading ? '...' : 'Decline'}
            </button>
          </div>
        )}

        {/* Coach can mark accepted session as completed */}
        {isCoach && session.status === 'accepted' && (
          <button
            onClick={() => updateSessionStatus(session.id, 'completed')}
            disabled={isLoading}
            className="w-full mt-3 border border-green-300 text-green-700 text-sm py-2 rounded-lg hover:bg-green-50 transition-colors font-medium disabled:opacity-50"
          >
            {isLoading ? '...' : 'Mark as Completed'}
          </button>
        )}

        {/* Client can leave review on completed sessions */}
        {!isCoach && session.status === 'completed' && !reviewed.has(session.id) && (
          <button
            onClick={() => setReviewSession(session)}
            className="w-full mt-3 bg-green-600 text-white text-sm py-2 rounded-lg hover:bg-green-700 transition-colors font-medium"
          >
            Leave a Review
          </button>
        )}

        {!isCoach && session.status === 'completed' && reviewed.has(session.id) && (
          <p className="mt-3 text-center text-xs text-green-600 font-medium">✓ Review submitted</p>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">My Sessions</h1>
        <p className="text-gray-600 mt-1">
          {role === 'coach' ? 'Manage session requests from clients' : 'Your coaching sessions'}
        </p>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <svg className="w-12 h-12 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-gray-500 text-lg mb-4">No sessions yet.</p>
          {role === 'client' && (
            <a href="/coaches" className="bg-green-600 text-white px-6 py-3 rounded-lg hover:bg-green-700 transition-colors font-medium inline-block">
              Browse Coaches
            </a>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {pending.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
                Pending ({pending.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {pending.map((s) => <SessionCard key={s.id} session={s} />)}
              </div>
            </section>
          )}
          {accepted.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
                Accepted ({accepted.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {accepted.map((s) => <SessionCard key={s.id} session={s} />)}
              </div>
            </section>
          )}
          {completed.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                Completed ({completed.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {completed.map((s) => <SessionCard key={s.id} session={s} />)}
              </div>
            </section>
          )}
          {cancelled.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
                Cancelled ({cancelled.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {cancelled.map((s) => <SessionCard key={s.id} session={s} />)}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Review Modal */}
      {reviewSession && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-gray-900">Leave a Review</h2>
              <button onClick={() => setReviewSession(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="bg-green-50 rounded-lg p-3 mb-5">
              <p className="text-sm font-medium text-gray-900">
                {reviewSession.coaches?.profiles?.full_name ?? 'Coach'}
              </p>
              <p className="text-xs text-gray-500">
                {new Date(reviewSession.scheduled_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>

            <form onSubmit={handleSubmitReview} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Your Rating</label>
                <StarRating rating={rating} size="lg" interactive onRate={setRating} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Comment <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Share your experience..."
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                />
              </div>
              {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setReviewSession(null)}
                  className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg hover:bg-gray-50 font-medium text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 font-medium text-sm disabled:opacity-50"
                >
                  {submitting ? 'Submitting...' : 'Submit Review'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
