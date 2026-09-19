'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { exportCallsToExcel } from '@/lib/exportCalls'
import type { CallOutcome, CallSection, SalesCall, SalesClient } from '@/lib/types'

interface CallsClientProps {
  userId: string
  initialClients: SalesClient[]
  initialCalls: SalesCall[]
}

const SECTIONS: { id: CallSection; label: string; sub: string }[] = [
  { id: 'wema', label: 'Wema Sales', sub: 'Machines' },
  { id: 'silica', label: 'Silica Sales', sub: 'Factory - East Pharma' },
]

const OUTCOMES: { id: CallOutcome; label: string; classes: string; dot: string }[] = [
  { id: 'cold', label: 'Cold', classes: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
  { id: 'warm', label: 'Warm', classes: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  { id: 'hot', label: 'Hot', classes: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
  { id: 'no_answer', label: 'No Answer', classes: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' },
]

function outcomeMeta(outcome: CallOutcome) {
  return OUTCOMES.find((o) => o.id === outcome)!
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export default function CallsClient({ userId, initialClients, initialCalls }: CallsClientProps) {
  const supabase = createClient()

  const [clients, setClients] = useState<SalesClient[]>(initialClients)
  const [calls, setCalls] = useState<SalesCall[]>(initialCalls)
  const [section, setSection] = useState<CallSection>('wema')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')

  const [exporting, setExporting] = useState(false)

  const sectionClients = useMemo(
    () =>
      clients
        .filter((c) => c.section === section)
        .filter((c) => {
          const q = search.trim().toLowerCase()
          if (!q) return true
          return c.name.toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q)
        }),
    [clients, section, search]
  )

  const callsByClient = useMemo(() => {
    const map = new Map<string, SalesCall[]>()
    for (const call of calls) {
      const list = map.get(call.client_id) ?? []
      list.push(call)
      map.set(call.client_id, list)
    }
    return map
  }, [calls])

  const selectedClient = clients.find((c) => c.id === selectedId) ?? null
  const selectedCalls = selectedId ? callsByClient.get(selectedId) ?? [] : []

  function lastCallFor(clientId: string): SalesCall | null {
    const list = callsByClient.get(clientId)
    return list && list.length > 0 ? list[0] : null
  }

  async function handleAddClient(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setAddSaving(true)
    setAddError('')

    const { data, error } = await supabase
      .from('sales_clients')
      .insert({
        user_id: userId,
        section,
        name: newName.trim(),
        phone: newPhone.trim() || null,
      })
      .select()
      .single()

    setAddSaving(false)
    if (error) {
      setAddError(error.message)
      return
    }

    setClients((prev) => [data as SalesClient, ...prev])
    setNewName('')
    setNewPhone('')
    setShowAdd(false)
    setSelectedId((data as SalesClient).id)
  }

  async function handleExport() {
    setExporting(true)
    try {
      exportCallsToExcel(clients, calls)
    } finally {
      setExporting(false)
    }
  }

  if (selectedClient) {
    return (
      <ClientDetail
        client={selectedClient}
        calls={selectedCalls}
        userId={userId}
        onBack={() => setSelectedId(null)}
        onClientUpdated={(updated) =>
          setClients((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
        }
        onCallAdded={(call, clientUpdatedAt) => {
          setCalls((prev) => [call, ...prev])
          setClients((prev) =>
            prev.map((c) => (c.id === call.client_id ? { ...c, updated_at: clientUpdatedAt } : c))
          )
        }}
      />
    )
  }

  return (
    <div className="px-4 pt-10 pb-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Call Tracker</h1>
        <button
          onClick={handleExport}
          disabled={exporting || clients.length === 0}
          className="text-sm font-medium text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg hover:bg-green-100 transition-colors disabled:opacity-50"
        >
          {exporting ? 'Exporting…' : '⬇ Backup to Excel'}
        </button>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 mb-4">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              section === s.id
                ? 'bg-green-600 border-green-600 text-white'
                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <div className="text-sm font-semibold">{s.label}</div>
            <div className={`text-[11px] ${section === s.id ? 'text-green-100' : 'text-gray-500'}`}>{s.sub}</div>
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients..."
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
        />
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="bg-green-600 text-white px-4 rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors"
        >
          + Add
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAddClient} className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-col gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Client Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Acme Factory"
              autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Client Number</label>
            <input
              type="tel"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="e.g. 010 1234 5678"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          {addError && <p className="text-xs text-red-600">{addError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={addSaving || !newName.trim()}
              className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              {addSaving ? 'Saving…' : 'Save Client'}
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-2">
        {sectionClients.length === 0 && (
          <p className="text-center text-sm text-gray-500 py-10">
            No clients yet in {SECTIONS.find((s) => s.id === section)?.label}. Tap + Add to create one.
          </p>
        )}
        {sectionClients.map((client) => {
          const last = lastCallFor(client.id)
          return (
            <button
              key={client.id}
              onClick={() => setSelectedId(client.id)}
              className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between text-left hover:shadow-sm transition-shadow"
            >
              <div>
                <p className="font-semibold text-gray-900 text-sm">{client.name}</p>
                {client.phone && <p className="text-xs text-gray-500 mt-0.5">{client.phone}</p>}
              </div>
              <div className="text-right">
                {last ? (
                  <>
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${outcomeMeta(last.outcome).classes}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${outcomeMeta(last.outcome).dot}`} />
                      {outcomeMeta(last.outcome).label}
                    </span>
                    <p className="text-[11px] text-gray-400 mt-1">{last.call_date}</p>
                  </>
                ) : (
                  <span className="text-[11px] text-gray-400">Not called yet</span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ClientDetail({
  client,
  calls,
  userId,
  onBack,
  onClientUpdated,
  onCallAdded,
}: {
  client: SalesClient
  calls: SalesCall[]
  userId: string
  onBack: () => void
  onClientUpdated: (client: SalesClient) => void
  onCallAdded: (call: SalesCall, clientUpdatedAt: string) => void
}) {
  const supabase = createClient()

  const [name, setName] = useState(client.name)
  const [phone, setPhone] = useState(client.phone ?? '')
  const [fieldStatus, setFieldStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  const [outcome, setOutcome] = useState<CallOutcome>('cold')
  const [callDate, setCallDate] = useState(todayStr())
  const [feedback, setFeedback] = useState('')
  const [logSaving, setLogSaving] = useState(false)
  const [logError, setLogError] = useState('')

  async function saveField(field: 'name' | 'phone', value: string) {
    setFieldStatus('saving')
    const { data, error } = await supabase
      .from('sales_clients')
      .update(field === 'name' ? { name: value.trim() } : { phone: value.trim() || null })
      .eq('id', client.id)
      .select()
      .single()

    if (!error && data) {
      onClientUpdated(data as SalesClient)
      setFieldStatus('saved')
      setTimeout(() => setFieldStatus('idle'), 1500)
    } else {
      setFieldStatus('idle')
    }
  }

  async function handleLogCall(e: React.FormEvent) {
    e.preventDefault()
    setLogSaving(true)
    setLogError('')

    const { data, error } = await supabase
      .from('sales_calls')
      .insert({
        client_id: client.id,
        user_id: userId,
        outcome,
        feedback: feedback.trim() || null,
        call_date: callDate,
      })
      .select()
      .single()

    if (error) {
      setLogError(error.message)
      setLogSaving(false)
      return
    }

    onCallAdded(data as SalesCall, new Date().toISOString())
    setFeedback('')
    setOutcome('cold')
    setCallDate(todayStr())
    setLogSaving(false)
  }

  return (
    <div className="px-4 pt-10 pb-6">
      <button onClick={onBack} className="text-sm font-medium text-gray-500 mb-4 flex items-center gap-1">
        ← Back
      </button>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-col gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Client Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== client.name && saveField('name', name)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Client Number</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => phone !== (client.phone ?? '') && saveField('phone', phone)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>
        <p className="text-[11px] text-gray-400 h-3">
          {fieldStatus === 'saving' && 'Saving…'}
          {fieldStatus === 'saved' && '✓ Saved'}
        </p>
      </div>

      <form onSubmit={handleLogCall} className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-col gap-3">
        <h2 className="font-semibold text-gray-900 text-sm">Log a Call</h2>

        <div className="grid grid-cols-4 gap-2">
          {OUTCOMES.map((o) => (
            <button
              type="button"
              key={o.id}
              onClick={() => setOutcome(o.id)}
              className={`text-xs font-medium py-2 rounded-lg border transition-colors ${
                outcome === o.id ? `${o.classes} ring-2 ring-offset-1 ring-green-500` : 'bg-gray-50 border-gray-200 text-gray-500'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Date Called</label>
          <input
            type="date"
            value={callDate}
            onChange={(e) => setCallDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Feedback {outcome === 'no_answer' && '(optional)'}
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={outcome === 'no_answer' ? 'Optional note...' : 'What did the client say?'}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
          />
        </div>

        {logError && <p className="text-xs text-red-600">{logError}</p>}

        <button
          type="submit"
          disabled={logSaving}
          className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-50"
        >
          {logSaving ? 'Saving…' : 'Save Call'}
        </button>
      </form>

      <div>
        <h2 className="font-semibold text-gray-900 text-sm mb-2">Call History</h2>
        {calls.length === 0 && <p className="text-sm text-gray-500">No calls logged yet.</p>}
        <div className="flex flex-col gap-2">
          {calls.map((call) => (
            <div key={call.id} className="bg-white border border-gray-200 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${outcomeMeta(call.outcome).classes}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${outcomeMeta(call.outcome).dot}`} />
                  {outcomeMeta(call.outcome).label}
                </span>
                <span className="text-[11px] text-gray-400">{call.call_date}</span>
              </div>
              {call.feedback && <p className="text-sm text-gray-700">{call.feedback}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
