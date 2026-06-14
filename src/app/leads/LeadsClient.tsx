'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Lead, LeadStatus, CompanyType } from '@/lib/types'

interface Props {
  initialLeads: Lead[]
}

const STATUS_LABELS: Record<LeadStatus, string> = {
  prospect: 'Prospect',
  contacted: 'Contacted',
  interested: 'Interested',
  negotiating: 'Negotiating',
  customer: 'Customer',
  lost: 'Lost',
}

const STATUS_COLORS: Record<LeadStatus, string> = {
  prospect: 'bg-gray-100 text-gray-700',
  contacted: 'bg-blue-100 text-blue-700',
  interested: 'bg-yellow-100 text-yellow-800',
  negotiating: 'bg-orange-100 text-orange-700',
  customer: 'bg-green-100 text-green-700',
  lost: 'bg-red-100 text-red-600',
}

const TYPE_COLORS: Record<CompanyType, string> = {
  pharmaceutical: 'bg-indigo-100 text-indigo-700',
  veterinary: 'bg-amber-100 text-amber-700',
  other: 'bg-gray-100 text-gray-600',
}

const TYPE_LABELS: Record<CompanyType, string> = {
  pharmaceutical: 'Pharma',
  veterinary: 'Veterinary',
  other: 'Other',
}

const PRODUCT_LABELS: Record<string, string> = {
  flip_off_caps: 'Flip-off Caps',
  sachets: 'Sachets',
}

const PRODUCT_COLORS: Record<string, string> = {
  flip_off_caps: 'bg-teal-100 text-teal-700',
  sachets: 'bg-purple-100 text-purple-700',
}

const EMPTY_FORM = {
  company_name: '',
  company_type: 'pharmaceutical' as CompanyType,
  products: [] as string[],
  contact_name: '',
  contact_phone: '',
  contact_email: '',
  website: '',
  city: '',
  address: '',
  status: 'prospect' as LeadStatus,
  notes: '',
}

export default function LeadsClient({ initialLeads }: Props) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | CompanyType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | LeadStatus>('all')
  const [productFilter, setProductFilter] = useState<'all' | 'flip_off_caps' | 'sachets'>('all')
  const [showModal, setShowModal] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [formError, setFormError] = useState('')
  const supabase = createClient()
  const router = useRouter()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/auth/login')
    router.refresh()
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return leads.filter((lead) => {
      if (q && !lead.company_name.toLowerCase().includes(q) &&
          !(lead.city ?? '').toLowerCase().includes(q) &&
          !(lead.contact_name ?? '').toLowerCase().includes(q)) return false
      if (typeFilter !== 'all' && lead.company_type !== typeFilter) return false
      if (statusFilter !== 'all' && lead.status !== statusFilter) return false
      if (productFilter !== 'all' && !lead.products.includes(productFilter)) return false
      return true
    })
  }, [leads, search, typeFilter, statusFilter, productFilter])

  const stats = useMemo(() => ({
    total: leads.length,
    customers: leads.filter((l) => l.status === 'customer').length,
    prospects: leads.filter((l) => l.status === 'prospect').length,
    active: leads.filter((l) => ['contacted', 'interested', 'negotiating'].includes(l.status)).length,
  }), [leads])

  const openAdd = () => {
    setEditingLead(null)
    setForm(EMPTY_FORM)
    setFormError('')
    setShowModal(true)
  }

  const openEdit = (lead: Lead) => {
    setEditingLead(lead)
    setForm({
      company_name: lead.company_name,
      company_type: lead.company_type,
      products: lead.products ?? [],
      contact_name: lead.contact_name ?? '',
      contact_phone: lead.contact_phone ?? '',
      contact_email: lead.contact_email ?? '',
      website: lead.website ?? '',
      city: lead.city ?? '',
      address: lead.address ?? '',
      status: lead.status,
      notes: lead.notes ?? '',
    })
    setFormError('')
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.company_name.trim()) {
      setFormError('Company name is required')
      return
    }
    setSaving(true)
    setFormError('')

    const payload = {
      company_name: form.company_name.trim(),
      company_type: form.company_type,
      products: form.products,
      contact_name: form.contact_name.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      contact_email: form.contact_email.trim() || null,
      website: form.website.trim() || null,
      city: form.city.trim() || null,
      address: form.address.trim() || null,
      status: form.status,
      notes: form.notes.trim() || null,
    }

    if (editingLead) {
      const { data, error } = await supabase
        .from('leads')
        .update(payload)
        .eq('id', editingLead.id)
        .select()
        .single()
      if (error) { setFormError(error.message); setSaving(false); return }
      setLeads((prev) => prev.map((l) => l.id === editingLead.id ? data as Lead : l))
    } else {
      const { data, error } = await supabase
        .from('leads')
        .insert(payload)
        .select()
        .single()
      if (error) { setFormError(error.message); setSaving(false); return }
      setLeads((prev) => [...prev, data as Lead].sort((a, b) => a.company_name.localeCompare(b.company_name)))
    }

    setSaving(false)
    setShowModal(false)
  }

  const handleDelete = async () => {
    if (!editingLead) return
    setDeleting(true)
    await supabase.from('leads').delete().eq('id', editingLead.id)
    setLeads((prev) => prev.filter((l) => l.id !== editingLead.id))
    setDeleting(false)
    setShowModal(false)
  }

  const updateStatus = async (id: string, status: LeadStatus) => {
    const { data, error } = await supabase
      .from('leads')
      .update({ status })
      .eq('id', id)
      .select()
      .single()
    if (!error && data) {
      setLeads((prev) => prev.map((l) => l.id === id ? data as Lead : l))
    }
  }

  const toggleProduct = (product: string) => {
    setForm((f) => ({
      ...f,
      products: f.products.includes(product)
        ? f.products.filter((p) => p !== product)
        : [...f.products, product],
    }))
  }

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white px-4 pt-12 pb-4 sticky top-0 z-10 border-b border-gray-100">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Lead Generation</h1>
            <p className="text-xs text-gray-500 mt-0.5">Flip-off Caps & Sachets Customers</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openAdd}
              className="bg-green-600 text-white px-3.5 py-2 rounded-xl font-medium text-sm hover:bg-green-700 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add
            </button>
            <button
              onClick={handleSignOut}
              className="text-gray-400 hover:text-gray-600 p-2 rounded-xl hover:bg-gray-100 transition-colors"
              aria-label="Sign out"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-2 mb-3">
          {[
            { label: 'Total', value: stats.total, color: 'text-gray-900' },
            { label: 'Prospects', value: stats.prospects, color: 'text-gray-500' },
            { label: 'Active', value: stats.active, color: 'text-blue-600' },
            { label: 'Customers', value: stats.customers, color: 'text-green-600' },
          ].map((s) => (
            <div key={s.label} className="bg-gray-50 rounded-xl p-2 text-center border border-gray-100">
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-2.5">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search companies, cities..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-gray-100 rounded-xl text-sm outline-none focus:ring-2 focus:ring-green-500 focus:bg-white transition-colors"
          />
        </div>

        {/* Filters */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white outline-none shrink-0 text-gray-700"
          >
            <option value="all">All Types</option>
            <option value="pharmaceutical">Pharmaceutical</option>
            <option value="veterinary">Veterinary</option>
            <option value="other">Other</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white outline-none shrink-0 text-gray-700"
          >
            <option value="all">All Statuses</option>
            {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <select
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value as typeof productFilter)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white outline-none shrink-0 text-gray-700"
          >
            <option value="all">All Products</option>
            <option value="flip_off_caps">Flip-off Caps</option>
            <option value="sachets">Sachets</option>
          </select>
        </div>
      </div>

      {/* Count */}
      <div className="px-4 py-2 text-xs text-gray-400">
        {filtered.length} {filtered.length === 1 ? 'company' : 'companies'}
      </div>

      {/* Lead cards */}
      <div className="px-4 pb-6 space-y-3 flex-1">
        {filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <p className="text-gray-500 font-medium">No companies found</p>
            <p className="text-gray-400 text-sm mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          filtered.map((lead) => (
            <div key={lead.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
              {/* Top row */}
              <div className="flex items-start justify-between gap-2 mb-2.5">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 text-[15px] leading-snug">{lead.company_name}</h3>
                  {lead.city && <p className="text-xs text-gray-400 mt-0.5">{lead.city}</p>}
                </div>
                <button
                  onClick={() => openEdit(lead)}
                  className="text-gray-300 hover:text-green-600 transition-colors p-1 -mt-0.5 shrink-0"
                  aria-label="Edit"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
              </div>

              {/* Type + product badges */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${TYPE_COLORS[lead.company_type]}`}>
                  {TYPE_LABELS[lead.company_type]}
                </span>
                {(lead.products ?? []).map((p) => (
                  <span key={p} className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${PRODUCT_COLORS[p] ?? 'bg-gray-100 text-gray-600'}`}>
                    {PRODUCT_LABELS[p] ?? p}
                  </span>
                ))}
              </div>

              {/* Contact info */}
              {(lead.contact_name || lead.contact_phone || lead.contact_email) && (
                <div className="space-y-1 mb-3">
                  {lead.contact_name && (
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      {lead.contact_name}
                    </div>
                  )}
                  {lead.contact_phone && (
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                      {lead.contact_phone}
                    </div>
                  )}
                  {lead.contact_email && (
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      {lead.contact_email}
                    </div>
                  )}
                </div>
              )}

              {lead.notes && (
                <p className="text-xs text-gray-400 italic mb-3 line-clamp-2">{lead.notes}</p>
              )}

              {/* Status row */}
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-50">
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[lead.status]}`}>
                  {STATUS_LABELS[lead.status]}
                </span>
                <select
                  value={lead.status}
                  onChange={(e) => updateStatus(lead.id, e.target.value as LeadStatus)}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white outline-none text-gray-600"
                >
                  {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="bg-white w-full max-h-[92vh] rounded-t-3xl overflow-y-auto">
            {/* Modal header */}
            <div className="sticky top-0 bg-white px-4 pt-4 pb-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900 text-lg">
                {editingLead ? 'Edit Company' : 'Add Company'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-4 py-4 space-y-4">
              {formError && (
                <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl">{formError}</p>
              )}

              {/* Company Name */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Company Name *</label>
                <input
                  type="text"
                  value={form.company_name}
                  onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
                  placeholder="e.g. Rameda Pharmaceuticals"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {/* Company Type */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Company Type *</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['pharmaceutical', 'veterinary', 'other'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, company_type: type }))}
                      className={`py-2.5 px-2 rounded-xl text-xs font-medium border transition-all ${
                        form.company_type === type
                          ? 'bg-green-600 text-white border-green-600'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-green-300'
                      }`}
                    >
                      {TYPE_LABELS[type]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Products */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Products Interested In</label>
                <div className="flex gap-2">
                  {(['flip_off_caps', 'sachets'] as const).map((product) => (
                    <button
                      key={product}
                      type="button"
                      onClick={() => toggleProduct(product)}
                      className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-medium border transition-all ${
                        form.products.includes(product)
                          ? 'bg-green-600 text-white border-green-600'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-green-300'
                      }`}
                    >
                      {PRODUCT_LABELS[product]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as LeadStatus }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 bg-white"
                >
                  {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>

              {/* City */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">City</label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                  placeholder="e.g. Cairo, Alexandria"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {/* Contact Name */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Contact Person</label>
                <input
                  type="text"
                  value={form.contact_name}
                  onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))}
                  placeholder="e.g. Ahmed Mohamed"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {/* Phone */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Phone</label>
                <input
                  type="tel"
                  value={form.contact_phone}
                  onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                  placeholder="+20 10 1234 5678"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {/* Email */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Email</label>
                <input
                  type="email"
                  value={form.contact_email}
                  onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                  placeholder="contact@company.com"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1.5">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Meeting notes, follow-up actions..."
                  rows={3}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 resize-none"
                />
              </div>

              {/* Actions */}
              <div className="pb-4 space-y-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 text-sm"
                >
                  {saving ? 'Saving...' : editingLead ? 'Save Changes' : 'Add Company'}
                </button>
                {editingLead && (
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="w-full bg-white text-red-500 py-3 rounded-xl font-medium border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50 text-sm"
                  >
                    {deleting ? 'Deleting...' : 'Delete Company'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
