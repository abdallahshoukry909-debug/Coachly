export type UserRole = 'coach' | 'client'

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
  specialty: string[]
  hourly_rate: number | null
  location: string | null
  years_experience: number | null
  certifications: string[] | null
  is_verified: boolean
  created_at: string
  profiles?: Profile
  average_rating?: number
  review_count?: number
}

export interface Session {
  id: string
  coach_id: string
  client_id: string
  scheduled_at: string
  duration_minutes: number
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled'
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
