'use client'

import { useState } from 'react'
import Link from 'next/link'
import BookingModal from '@/components/BookingModal'
import type { Coach } from '@/lib/types'

interface CoachBookingSectionProps {
  coach: Coach
  userId: string | null
  isClient: boolean
}

export default function CoachBookingSection({ coach, userId, isClient }: CoachBookingSectionProps) {
  const [showModal, setShowModal] = useState(false)
  const [booked, setBooked] = useState(false)

  if (booked) {
    return (
      <div className="bg-green-50 rounded-xl border border-green-200 p-6 text-center sticky top-20">
        <div className="w-12 h-12 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-3">
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="font-semibold text-gray-900 mb-1">Session Booked!</h3>
        <p className="text-sm text-gray-600 mb-4">Your session request has been sent to the coach.</p>
        <Link href="/sessions" className="text-green-600 font-medium hover:underline text-sm">
          View My Sessions
        </Link>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 sticky top-20">
      <h3 className="font-semibold text-gray-900 mb-4">Book a Session</h3>

      {coach.price_per_session != null && (
        <div className="mb-4">
          <span className="text-3xl font-bold text-gray-900">${coach.price_per_session}</span>
          <span className="text-gray-500"> / session</span>
        </div>
      )}

      <ul className="flex flex-col gap-2 mb-6 text-sm text-gray-600">
        <li className="flex items-center gap-2">
          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          60-minute sessions
        </li>
        <li className="flex items-center gap-2">
          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Direct messaging with coach
        </li>
        <li className="flex items-center gap-2">
          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Money-back guarantee
        </li>
      </ul>

      {!userId ? (
        <Link
          href="/auth/login"
          className="block text-center w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition-colors font-semibold"
        >
          Sign in to Book
        </Link>
      ) : !isClient ? (
        <p className="text-sm text-gray-500 text-center">
          Only clients can book sessions.
        </p>
      ) : (
        <button
          onClick={() => setShowModal(true)}
          className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition-colors font-semibold"
        >
          Book a Session
        </button>
      )}

      {showModal && userId && (
        <BookingModal
          coach={coach}
          clientId={userId}
          onClose={() => setShowModal(false)}
          onBooked={() => {
            setShowModal(false)
            setBooked(true)
          }}
        />
      )}
    </div>
  )
}
