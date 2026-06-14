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
