'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Coach } from '@/lib/types'

interface BookingModalProps {
  coach: Coach
  clientId: string
  onClose: () => void
  onBooked: () => void
}

export default function BookingModal({ coach, clientId, onClose, onBooked }: BookingModalProps) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!date || !time) {
      setError('Please select a date and time.')
      return
    }
    setLoading(true)
    setError('')

    const { error: insertError } = await supabase.from('sessions').insert({
      coach_id: coach.id,
      client_id: clientId,
      scheduled_at: new Date(`${date}T${time}:00`).toISOString(),
      duration_minutes: 60,
      status: 'pending',
      notes: notes || null,
      price: coach.price_per_session,
    })

    setLoading(false)
    if (insertError) {
      setError(insertError.message)
    } else {
      onBooked()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-gray-900">Book a Session</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="bg-green-50 rounded-lg p-3 mb-5">
          <p className="text-sm font-medium text-gray-900">{coach.profiles?.full_name}</p>
          {coach.price_per_session != null && (
            <p className="text-sm text-gray-600">${coach.price_per_session} · 60 min session</p>
          )}
          {coach.category && (
            <p className="text-xs text-gray-500 mt-0.5">{coach.category}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={date}
              min={new Date().toISOString().split('T')[0]}
              onChange={(e) => setDate(e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What would you like to focus on?"
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
            />
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg hover:bg-gray-50 font-medium text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 font-medium text-sm disabled:opacity-50"
            >
              {loading ? 'Booking...' : 'Confirm Booking'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
