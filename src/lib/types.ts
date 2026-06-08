export type UserRole = 'coach' | 'client'
export type SessionStatus = 'pending' | 'accepted' | 'completed' | 'cancelled'

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
