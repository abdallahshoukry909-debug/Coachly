export type UserRole = 'coach' | 'client'
export type SessionStatus = 'pending' | 'accepted' | 'completed' | 'cancelled'
export type LeadStatus = 'prospect' | 'contacted' | 'interested' | 'negotiating' | 'customer' | 'lost'
export type CompanyType = 'pharmaceutical' | 'veterinary' | 'other'

export interface Lead {
  id: string
  company_name: string
  company_type: CompanyType
  products: string[]
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  website: string | null
  city: string | null
  address: string | null
  status: LeadStatus
  notes: string | null
  created_at: string
  updated_at: string
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
