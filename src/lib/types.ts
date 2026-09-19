export type UserRole = 'coach' | 'client'
export type SessionStatus = 'pending' | 'accepted' | 'completed' | 'cancelled'

export type CallSection = 'wema' | 'silica'
export type CallOutcome = 'cold' | 'warm' | 'hot' | 'no_answer'

export interface SalesClient {
  id: string
  user_id: string
  section: CallSection
  name: string
  phone: string | null
  created_at: string
  updated_at: string
}

export interface SalesCall {
  id: string
  client_id: string
  user_id: string
  outcome: CallOutcome
  feedback: string | null
  call_date: string
  created_at: string
}

export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  role: UserRole
  bio: string | null
  created_at: string
}

export interface Coach {
  id: string
  user_id: string
  category: string | null
  price_per_session: number | null
  location: string | null
  years_experience: number | null
  rating_avg: number
  total_reviews: number
  is_verified: boolean
  created_at: string
  profiles?: Profile
}

export interface Session {
  id: string
  coach_id: string
  client_id: string
  scheduled_at: string
  duration_minutes: number
  status: SessionStatus
  notes: string | null
  price: number | null
  created_at: string
  coaches?: Coach & { profiles?: Profile }
  profiles?: Profile
}

export interface Review {
  id: string
  session_id: string
  reviewer_id: string
  coach_id: string
  rating: number
  comment: string | null
  created_at: string
  profiles?: Profile
}
