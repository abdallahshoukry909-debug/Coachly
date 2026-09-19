export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  created_at: string
}

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
