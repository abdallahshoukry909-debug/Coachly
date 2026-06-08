'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Profile, Coach } from '@/lib/types'

const CATEGORIES = ['Fitness', 'Business', 'Life', 'Language', 'Career', 'Nutrition', 'Mindfulness', 'Other']

interface ProfileClientProps {
  profile: Profile | null
  coachData: Coach | null
}

export default function ProfileClient({ profile, coachData }: ProfileClientProps) {
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [bio, setBio] = useState(profile?.bio ?? '')
  const [category, setCategory] = useState(coachData?.category ?? '')
  const [pricePerSession, setPricePerSession] = useState(coachData?.price_per_session?.toString() ?? '')
  const [location, setLocation] = useState(coachData?.location ?? '')
  const [yearsExp, setYearsExp] = useState(coachData?.years_experience?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const supabase = createClient()

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    setSaving(true)
    setMessage(null)

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ full_name: fullName || null, bio: bio || null })
      .eq('id', profile.id)

    if (profileError) {
      setMessage({ type: 'error', text: profileError.message })
      setSaving(false)
      return
    }

    if (profile.role === 'coach' && coachData) {
      const { error: coachError } = await supabase
        .from('coaches')
        .update({
          category: category || null,
          price_per_session: pricePerSession ? parseFloat(pricePerSession) : null,
          location: location || null,
          years_experience: yearsExp ? parseInt(yearsExp) : null,
        })
        .eq('id', coachData.id)

      if (coachError) {
        setMessage({ type: 'error', text: coachError.message })
        setSaving(false)
        return
      }
    }

    setMessage({ type: 'success', text: 'Profile saved successfully!' })
    setSaving(false)
  }

  if (!profile) {
    return (
      <div className="text-center py-20 text-gray-500">
        <p>Unable to load profile.</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Edit Profile</h1>
        <p className="text-gray-600 mt-1">
          Update your {profile.role === 'coach' ? 'coach' : 'client'} profile
        </p>
      </div>

      <form onSubmit={handleSave} className="flex flex-col gap-6">
        {/* Personal Info */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Personal Information</h2>
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={profile.email}
                disabled
                className="w-full border border-gray-100 rounded-lg px-3 py-2.5 text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bio</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Tell people about yourself..."
                rows={4}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
              />
            </div>
          </div>
        </div>

        {/* Coach-specific fields */}
        {profile.role === 'coach' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-4">Coach Details</h2>
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                >
                  <option value="">Select a category</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Price per Session ($)
                  </label>
                  <input
                    type="number"
                    value={pricePerSession}
                    onChange={(e) => setPricePerSession(e.target.value)}
                    placeholder="100"
                    min="0"
                    step="0.01"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Years of Experience
                  </label>
                  <input
                    type="number"
                    value={yearsExp}
                    onChange={(e) => setYearsExp(e.target.value)}
                    placeholder="5"
                    min="0"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="New York, NY"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>
        )}

        {message && (
          <div
            className={`px-4 py-3 rounded-lg text-sm ${
              message.type === 'success'
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}
          >
            {message.text}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition-colors font-semibold disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </form>
    </div>
  )
}
