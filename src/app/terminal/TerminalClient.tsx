'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { sma } from '@/lib/market/indicators'
import type { Headline } from '@/lib/market/data'
import type { Action, Regime, Signal } from '@/lib/market/signals'
import { MARKETS, type MarketId } from '@/lib/market/markets'

// ---------- types ----------

interface Quote {
  symbol: string
  name: string
  currency: string
  price: number
  source: string
  chart: { time: number[]; close: number[] }
  signal: Signal
  usd: { m1: number; m3: number; y1: number; fxName: string; fxRate: number } | null
  avgValue: number
  news: Headline[]
  updated: string
}

interface World {
  overview: { symbol: string; label: string; price: number | null; change: number | null; spark: number[] }[]
  regime: Regime
  worldSentiment: number
  topics: Record<string, { count: number; sentiment: number }>
  headlines: Headline[]
  errors: number
  updated: string
}

interface Position {
  shares: number
  entry: number
}

interface Alert {
  id: string
  at: string
  symbol: string
  text: string
  tone: 'good' | 'bad' | 'info'
}

// ---------- persistence (per-browser) ----------

const watchlistKey = (m: MarketId) => `terminal.watchlist.${m}`

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

// ---------- formatting ----------

const fmt = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const pct = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const tone = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? 'text-zinc-400' : n >= 0 ? 'text-emerald-400' : 'text-rose-400'
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (m < 60) return `${Math.max(m, 0)}m`
  if (m < 1440) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

const ACTION_STYLE: Record<Action, string> = {
  BUY: 'bg-emerald-500 text-black',
  ACCUMULATE: 'bg-emerald-900 text-emerald-300 border border-emerald-600',
  HOLD: 'bg-zinc-800 text-zinc-300 border border-zinc-600',
  REDUCE: 'bg-amber-900 text-amber-300 border border-amber-600',
  EXIT: 'bg-rose-600 text-white',
}

const ACTION_TEXT: Record<Action, string> = {
  BUY: 'Conditions favour buying now.',
  ACCUMULATE: 'Leaning bullish. Build a position gradually or buy on dips toward the entry level.',
  HOLD: 'Mixed signals. Hold what you have; no strong reason to act.',
  REDUCE: 'Weakening. Consider trimming, tightening stops, or waiting before buying.',
  EXIT: 'Bearish. Conditions favour getting out or staying out.',
}

// ---------- small components ----------

function Sparkline({ data, className = '' }: { data: number[]; className?: string }) {
  if (data.length < 2) return <div className={className} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${30 - ((v - min) / (max - min || 1)) * 30}`).join(' ')
  const up = data[data.length - 1] >= data[0]
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={className}>
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#fb7185'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function PriceChart({ q, position }: { q: Quote; position?: Position }) {
  const close = q.chart.close
  const s50 = useMemo(() => sma(close, 50), [close])
  const s200 = useMemo(() => sma(close, 200), [close])
  const [hover, setHover] = useState<number | null>(null)
  if (close.length < 2) return null

  const W = 600
  const H = 220
  const { stopLoss, takeProfit, trailingStop } = q.signal.levels
  const levels = [stopLoss, takeProfit, trailingStop, ...(position ? [position.entry] : [])].filter(Number.isFinite)
  const lines = [...close, ...s50.filter((v) => !Number.isNaN(v)), ...s200.filter((v) => !Number.isNaN(v)), ...levels]
  const min = Math.min(...lines) * 0.98
  const max = Math.max(...lines) * 1.02
  const x = (i: number) => (i / (close.length - 1)) * W
  const y = (v: number) => H - ((v - min) / (max - min)) * H
  const path = (arr: number[]) =>
    arr.map((v, i) => (Number.isNaN(v) ? '' : `${x(i)},${y(v)}`)).filter(Boolean).join(' ')
  const hl = (v: number, color: string, label: string) =>
    v > min && v < max ? (
      <g key={label}>
        <line x1={0} x2={W} y1={y(v)} y2={y(v)} stroke={color} strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <text x={4} y={y(v) - 3} fill={color} fontSize={10}>{label} {fmt(v)}</text>
      </g>
    ) : null
  const hi = hover ?? close.length - 1

  return (
    <div className="relative">
      <div className="flex gap-4 text-[11px] mb-1 text-zinc-400">
        <span className="text-sky-300">— Price</span>
        <span className="text-amber-300">— 50d avg</span>
        <span className="text-fuchsia-300">— 200d avg</span>
        <span className="ml-auto text-zinc-300">
          {new Date(q.chart.time[hi] * 1000).toLocaleDateString()} · {fmt(close[hi])}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-56"
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setHover(Math.round(((e.clientX - r.left) / r.width) * (close.length - 1)))
        }}
      >
        <polyline points={path(s200)} fill="none" stroke="#f0abfc" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline points={path(s50)} fill="none" stroke="#fcd34d" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline points={path(close)} fill="none" stroke="#7dd3fc" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {hl(takeProfit, '#34d399', 'TARGET')}
        {hl(stopLoss, '#fb7185', 'STOP')}
        {hl(trailingStop, '#fbbf24', 'TRAIL')}
        {position && hl(position.entry, '#a5b4fc', 'YOUR ENTRY')}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="#52525b" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  )
}

function Panel({ title, right, children, className = '' }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`border border-zinc-800 bg-zinc-950 rounded ${className}`}>
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/60">
        <h2 className="text-[11px] tracking-widest text-amber-400 font-bold">{title}</h2>
        {right}
      </header>
      <div className="p-3">{children}</div>
    </section>
  )
}

function NewsList({ items, max = 30 }: { items: Headline[]; max?: number }) {
  if (!items.length) return <p className="text-zinc-500 text-xs">No headlines.</p>
  return (
    <ul className="space-y-2">
      {items.slice(0, max).map((h) => (
        <li key={h.link + h.title} className="text-xs leading-snug">
          <a href={h.link} target="_blank" rel="noreferrer" dir="auto" className="block hover:text-amber-300">
            <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${h.sentiment > 0.15 ? 'bg-emerald-400' : h.sentiment < -0.15 ? 'bg-rose-400' : 'bg-zinc-500'}`} />
            {h.title}
          </a>
          <div className="text-[10px] text-zinc-500 mt-0.5">
            <bdi>{h.source}</bdi> · {ago(h.published)} · <span className="text-sky-400">{h.topic}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------- main ----------

export default function TerminalClient() {
  const [market, setMarket] = useState<MarketId>('us')
  const [watchlist, setWatchlist] = useState<string[]>(MARKETS.us.defaultWatchlist)
  const [positions, setPositions] = useState<Record<string, Position>>({})
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [selected, setSelected] = useState('AAPL')
  const [quotes, setQuotes] = useState<Record<string, Quote | { error: string }>>({})
  const [world, setWorld] = useState<World | null>(null)
  const [worldError, setWorldError] = useState<string | null>(null)
  const [topicFilter, setTopicFilter] = useState<string>('All')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState<Date | null>(null)
  const [notify, setNotify] = useState(false)
  const lastActions = useRef<Record<string, Action>>({})
  const hydrated = useRef(false)

  // Load saved state once on mount.
  useEffect(() => {
    const m = load<MarketId>('terminal.market', 'us') === 'eg' ? 'eg' : 'us'
    // Older versions stored a single US watchlist under 'terminal.watchlist'.
    const legacy = m === 'us' ? load<string[] | null>('terminal.watchlist', null) : null
    const wl = load<string[]>(watchlistKey(m), legacy ?? MARKETS[m].defaultWatchlist)
    /* eslint-disable react-hooks/set-state-in-effect -- hydrating from localStorage */
    setMarket(m)
    setWatchlist(wl)
    setSelected(wl[0] ?? 'SPY')
    setPositions(load('terminal.positions', {}))
    setAlerts(load('terminal.alerts', []))
    setNotify(typeof Notification !== 'undefined' && Notification.permission === 'granted')
    setNow(new Date())
    /* eslint-enable react-hooks/set-state-in-effect */
    lastActions.current = load('terminal.lastActions', {})
    hydrated.current = true
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => { if (hydrated.current) save(watchlistKey(market), watchlist) }, [market, watchlist])
  useEffect(() => { if (hydrated.current) save('terminal.positions', positions) }, [positions])
  useEffect(() => { if (hydrated.current) save('terminal.alerts', alerts.slice(0, 100)) }, [alerts])

  const pushAlert = useCallback((a: Omit<Alert, 'id' | 'at'>) => {
    setAlerts((prev) => [{ ...a, id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString() }, ...prev].slice(0, 100))
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(`${a.symbol}: ${a.text}`) } catch { /* ignore */ }
    }
  }, [])

  const refreshId = useRef(0)
  const refresh = useCallback(async () => {
    // Ignore results from a refresh that was superseded (e.g. market switched).
    const id = ++refreshId.current
    const stale = () => id !== refreshId.current
    setLoading(true)
    let regimeScore: number | null = null
    try {
      const res = await fetch(`/api/market/world?market=${market}`, { cache: 'no-store' })
      const w: World = await res.json()
      if (stale()) return
      setWorld(w)
      setWorldError(null)
      regimeScore = w.regime.score
    } catch {
      setWorldError('Could not load world data.')
    }

    const results = await Promise.all(
      watchlist.map(async (sym) => {
        try {
          const qs = new URLSearchParams({ symbol: sym })
          if (regimeScore != null) qs.set('regime', String(regimeScore))
          const res = await fetch(`/api/market/quote?${qs}`, { cache: 'no-store' })
          const data = await res.json()
          return [sym, res.ok ? (data as Quote) : { error: data.error ?? 'Failed' }] as const
        } catch {
          return [sym, { error: 'Network error' }] as const
        }
      })
    )
    if (stale()) return
    setQuotes(Object.fromEntries(results))

    // Alerts: signal changes and position exit levels.
    for (const [sym, q] of results) {
      if ('error' in q) continue
      const prev = lastActions.current[sym]
      const act = q.signal.action
      if (prev && prev !== act) {
        const good = act === 'BUY' || act === 'ACCUMULATE'
        pushAlert({ symbol: sym, text: `signal changed ${prev} → ${act} @ ${fmt(q.price)}`, tone: good ? 'good' : act === 'HOLD' ? 'info' : 'bad' })
      }
      lastActions.current[sym] = act
    }
    save('terminal.lastActions', lastActions.current)
    setLoading(false)
  }, [market, watchlist, pushAlert])

  // Position-level alerts (stop / target hits) — checked whenever quotes update.
  const firedLevels = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const [sym, pos] of Object.entries(positions)) {
      const q = quotes[sym]
      if (!q || 'error' in q) continue
      const { stopLoss, takeProfit, trailingStop } = q.signal.levels
      const stop = Math.max(stopLoss, trailingStop)
      const key = q.price <= stop ? 'stop' : q.price >= takeProfit ? 'target' : ''
      if (key && firedLevels.current[sym] !== key) {
        pushAlert(
          key === 'stop'
            ? { symbol: sym, text: `hit stop level ${fmt(stop)} — consider getting out (P/L ${pct(((q.price - pos.entry) / pos.entry) * 100)})`, tone: 'bad' }
            : { symbol: sym, text: `reached target ${fmt(takeProfit)} — consider taking profit (P/L ${pct(((q.price - pos.entry) / pos.entry) * 100)})`, tone: 'good' }
        )
      }
      firedLevels.current[sym] = key
    }
  }, [quotes, positions, pushAlert])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    refresh()
    const t = setInterval(refresh, 60_000)
    return () => clearInterval(t)
  }, [refresh])

  const switchMarket = (m: MarketId) => {
    if (m === market) return
    const wl = load<string[]>(watchlistKey(m), MARKETS[m].defaultWatchlist)
    save('terminal.market', m)
    setMarket(m)
    setWatchlist(wl)
    setSelected(wl[0] ?? '')
    setQuotes({})
    setWorld(null)
    setTopicFilter('All')
  }

  const addSymbol = (e: React.FormEvent) => {
    e.preventDefault()
    let s = input.trim().toUpperCase()
    // In Egypt mode, plain tickers like "ORAS" mean the EGX listing ORAS.CA.
    if (market === 'eg' && s && !/[.^=\-]/.test(s)) s = `${s}.CA`
    if (!s || !/^[A-Z0-9.^=\-]{1,15}$/.test(s)) return
    if (!watchlist.includes(s)) setWatchlist([...watchlist, s])
    setSelected(s)
    setInput('')
  }

  const removeSymbol = (s: string) => {
    const wl = watchlist.filter((x) => x !== s)
    setWatchlist(wl)
    if (selected === s) setSelected(wl[0] ?? '')
  }

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return
    const p = await Notification.requestPermission()
    setNotify(p === 'granted')
  }

  const q = quotes[selected]
  const quote = q && !('error' in q) ? q : null
  const position = positions[selected]

  const ranked = useMemo(
    () =>
      watchlist
        .map((s) => quotes[s])
        .filter((x): x is Quote => !!x && !('error' in x))
        .sort((a, b) => b.signal.score - a.signal.score),
    [watchlist, quotes]
  )

  const headlines = (world?.headlines ?? []).filter((h) => topicFilter === 'All' || h.topic === topicFilter)
  const regime = world?.regime

  return (
    <div className="min-h-screen bg-black text-zinc-200 font-mono text-sm">
      {/* Top bar */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 bg-zinc-950 border-b border-amber-500/40">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-xs">← App</Link>
        <span className="text-amber-400 font-bold tracking-widest">MARKET TERMINAL</span>
        <div className="flex rounded border border-zinc-700 overflow-hidden text-[11px]">
          {(Object.keys(MARKETS) as MarketId[]).map((m) => (
            <button
              key={m}
              onClick={() => switchMarket(m)}
              className={`px-2 py-0.5 ${market === m ? 'bg-amber-500 text-black font-bold' : 'text-zinc-400 hover:text-white'}`}
            >
              {m === 'eg' ? '🇪🇬 EGYPT' : '🇺🇸 US'}
            </button>
          ))}
        </div>
        {regime && (
          <span
            className={`px-2 py-0.5 text-[11px] font-bold rounded ${regime.label === 'RISK-ON' ? 'bg-emerald-600 text-black' : regime.label === 'RISK-OFF' ? 'bg-rose-600 text-white' : 'bg-zinc-700'}`}
            title={regime.reasons.join('\n')}
          >
            MARKET: {regime.label}
          </span>
        )}
        <span className="text-zinc-500 text-xs ml-auto">{now?.toLocaleString()}</span>
        <button onClick={enableNotifications} className={`text-xs px-2 py-0.5 rounded border ${notify ? 'border-emerald-600 text-emerald-400' : 'border-zinc-700 text-zinc-400 hover:text-white'}`}>
          {notify ? '🔔 Alerts on' : '🔕 Enable alerts'}
        </button>
        <button onClick={refresh} disabled={loading} className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:border-amber-500 disabled:opacity-50">
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Ticker strip */}
      <div className="flex overflow-x-auto border-b border-zinc-800 bg-zinc-950">
        {(world?.overview ?? []).map((o) => (
          <div key={o.symbol} className="min-w-[140px] px-3 py-2 border-r border-zinc-800">
            <div className="text-[10px] text-zinc-500">{o.label}</div>
            <div className="flex items-baseline gap-2">
              <span className="font-bold">{fmt(o.price)}</span>
              <span className={`text-[11px] ${tone(o.change)}`}>{pct(o.change)}</span>
            </div>
            <Sparkline data={o.spark} className="w-full h-5 mt-0.5" />
          </div>
        ))}
        {!world && !worldError && <div className="px-4 py-3 text-zinc-500 text-xs">Loading markets…</div>}
        {worldError && <div className="px-4 py-3 text-rose-400 text-xs">{worldError}</div>}
      </div>

      <div className="grid gap-3 p-3 lg:grid-cols-[300px_1fr_360px]">
        {/* LEFT: watchlist + alerts */}
        <div className="space-y-3">
          <Panel title="WATCHLIST" right={<span className="text-[10px] text-zinc-500">ranked by signal</span>}>
            <form onSubmit={addSymbol} className="flex gap-2 mb-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={market === 'eg' ? 'Add ticker (e.g. ORAS)' : 'Add ticker (e.g. META)'}
                className="flex-1 bg-black border border-zinc-700 rounded px-2 py-1 text-xs uppercase focus:outline-none focus:border-amber-500"
              />
              <button className="px-2 text-xs bg-amber-500 text-black font-bold rounded">ADD</button>
            </form>
            <ul className="divide-y divide-zinc-900">
              {watchlist.map((s) => {
                const item = quotes[s]
                const ok = item && !('error' in item) ? item : null
                return (
                  <li key={s} className={`flex items-center gap-2 py-1.5 px-1 cursor-pointer group ${selected === s ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'}`} onClick={() => setSelected(s)}>
                    <span className="w-[4.5rem] shrink-0 font-bold">{s}{positions[s] && <span className="text-indigo-300" title="You hold this"> ●</span>}</span>
                    <span className="flex-1 text-right">{ok ? fmt(ok.price) : item ? <span className="text-rose-400 text-[10px]">error</span> : '…'}</span>
                    <span className={`w-16 text-right text-xs ${tone(ok?.signal.stats.change1d)}`}>{ok ? pct(ok.signal.stats.change1d) : ''}</span>
                    {ok && <span className={`w-[78px] text-center text-[10px] font-bold rounded px-1 ${ACTION_STYLE[ok.signal.action]}`}>{ok.signal.action}</span>}
                    <button onClick={(e) => { e.stopPropagation(); removeSymbol(s) }} className="text-zinc-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 text-xs" aria-label={`Remove ${s}`}>✕</button>
                  </li>
                )
              })}
            </ul>
          </Panel>

          {ranked.length > 0 && (
            <Panel title="OPPORTUNITIES">
              <div className="text-xs space-y-1">
                <div className="text-zinc-500">Strongest:</div>
                {ranked.filter((r) => r.signal.score >= 20).slice(0, 3).map((r) => (
                  <button key={r.symbol} onClick={() => setSelected(r.symbol)} className="block text-emerald-400 hover:underline">▲ {r.symbol} score {r.signal.score}</button>
                ))}
                {!ranked.some((r) => r.signal.score >= 20) && <div className="text-zinc-500">Nothing strong right now.</div>}
                <div className="text-zinc-500 pt-2">Weakest:</div>
                {ranked.filter((r) => r.signal.score <= -20).slice(-3).reverse().map((r) => (
                  <button key={r.symbol} onClick={() => setSelected(r.symbol)} className="block text-rose-400 hover:underline">▼ {r.symbol} score {r.signal.score}</button>
                ))}
                {!ranked.some((r) => r.signal.score <= -20) && <div className="text-zinc-500">No major red flags.</div>}
              </div>
            </Panel>
          )}

          <Panel title="ALERTS" right={alerts.length ? <button onClick={() => setAlerts([])} className="text-[10px] text-zinc-500 hover:text-white">clear</button> : null}>
            {alerts.length === 0 ? (
              <p className="text-xs text-zinc-500">Signal changes and stop/target hits appear here (checked every minute while this page is open).</p>
            ) : (
              <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                {alerts.map((a) => (
                  <li key={a.id} className="text-xs">
                    <span className="text-zinc-500">{new Date(a.at).toLocaleTimeString()} </span>
                    <span className="font-bold">{a.symbol}</span>{' '}
                    <span className={a.tone === 'good' ? 'text-emerald-400' : a.tone === 'bad' ? 'text-rose-400' : 'text-zinc-300'}>{a.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* CENTER: selected symbol */}
        <div className="space-y-3 min-w-0">
          {q && 'error' in q && <Panel title={selected}><p className="text-rose-400 text-xs">{q.error}</p></Panel>}
          {!q && <Panel title={selected || 'SELECT A TICKER'}><p className="text-zinc-500 text-xs">Loading…</p></Panel>}
          {quote && (
            <>
              <Panel
                title={`${quote.symbol} · ${quote.name}`}
                right={<span className="text-[10px] text-zinc-500">src: {quote.source} · {new Date(quote.updated).toLocaleTimeString()}</span>}
              >
                <div className="flex flex-wrap items-end gap-x-6 gap-y-2 mb-3">
                  <div>
                    <div className="text-3xl font-bold">{fmt(quote.price)} <span className="text-xs text-zinc-500">{quote.currency}</span></div>
                    <div className={`text-sm ${tone(quote.signal.stats.change1d)}`}>{pct(quote.signal.stats.change1d)} today</div>
                  </div>
                  <div className="grid grid-cols-4 gap-x-4 text-xs">
                    {([['1M', quote.signal.stats.change1m], ['3M', quote.signal.stats.change3m], ['1Y', quote.signal.stats.change1y], ['From 52w high', quote.signal.stats.fromHigh]] as const).map(([l, v]) => (
                      <div key={l}><div className="text-zinc-500 text-[10px]">{l}</div><div className={tone(v)}>{pct(v)}</div></div>
                    ))}
                  </div>
                  {quote.usd && (
                    <div className="grid grid-cols-3 gap-x-4 text-xs border-l border-zinc-800 pl-4" title={`Converted at ${quote.usd.fxName} ${fmt(quote.usd.fxRate)}`}>
                      {([['1M in USD', quote.usd.m1], ['3M in USD', quote.usd.m3], ['1Y in USD', quote.usd.y1]] as const).map(([l, v]) => (
                        <div key={l}><div className="text-zinc-500 text-[10px]">{l}</div><div className={tone(v)}>{pct(v)}</div></div>
                      ))}
                    </div>
                  )}
                </div>
                <PriceChart q={quote} position={position} />
              </Panel>

              <div className="grid gap-3 md:grid-cols-2">
                <Panel title="SIGNAL">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`px-3 py-1 text-lg font-bold rounded ${ACTION_STYLE[quote.signal.action]}`}>{quote.signal.action}</span>
                    <div className="flex-1">
                      <div className="h-2 bg-zinc-800 rounded relative overflow-hidden">
                        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-zinc-500" />
                        <div
                          className={`absolute top-0 bottom-0 ${quote.signal.score >= 0 ? 'bg-emerald-500 left-1/2' : 'bg-rose-500'}`}
                          style={quote.signal.score >= 0 ? { width: `${quote.signal.score / 2}%` } : { right: '50%', width: `${-quote.signal.score / 2}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5"><span>-100 exit</span><span>score {quote.signal.score}</span><span>buy +100</span></div>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-300 mb-3">{ACTION_TEXT[quote.signal.action]}</p>
                  <ul className="space-y-1">
                    {quote.signal.reasons.map((r) => (
                      <li key={r.label} className="flex gap-2 text-xs">
                        <span className={`w-9 text-right font-bold ${r.points > 0 ? 'text-emerald-400' : r.points < 0 ? 'text-rose-400' : 'text-zinc-500'}`}>{r.points > 0 ? '+' : ''}{Math.round(r.points)}</span>
                        <span className="text-zinc-300">{r.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {quote.signal.events.length > 0 && (
                    <div className="mt-3 border-t border-zinc-800 pt-2 space-y-1">
                      {quote.signal.events.map((e) => <div key={e} className="text-xs text-amber-300">⚑ {e}</div>)}
                    </div>
                  )}
                </Panel>

                <Panel title="WHEN TO GET IN / OUT">
                  <table className="w-full text-xs mb-3">
                    <tbody>
                      <tr><td className="text-zinc-500 py-0.5">Entry zone</td><td className="text-right text-sky-300">{fmt(quote.signal.levels.entry)}</td></tr>
                      <tr><td className="text-zinc-500 py-0.5">Stop-loss (get out if below)</td><td className="text-right text-rose-400">{fmt(quote.signal.levels.stopLoss)}</td></tr>
                      <tr><td className="text-zinc-500 py-0.5">Trailing stop (trend break)</td><td className="text-right text-amber-300">{fmt(quote.signal.levels.trailingStop)}</td></tr>
                      <tr><td className="text-zinc-500 py-0.5">Profit target (2:1)</td><td className="text-right text-emerald-400">{fmt(quote.signal.levels.takeProfit)}</td></tr>
                    </tbody>
                  </table>
                  <PositionBox
                    key={selected}
                    symbol={selected}
                    price={quote.price}
                    signal={quote.signal}
                    position={position}
                    onSave={(p) => setPositions((prev) => {
                      const next = { ...prev }
                      if (p) next[selected] = p
                      else delete next[selected]
                      return next
                    })}
                  />
                </Panel>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Panel title="KEY STATS">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {([
                      ['RSI (14)', fmt(quote.signal.stats.rsi, 0)],
                      ['Volatility (ann.)', `${fmt(quote.signal.stats.volatility, 1)}%`],
                      ['20-day avg', fmt(quote.signal.stats.sma20)],
                      ['50-day avg', fmt(quote.signal.stats.sma50)],
                      ['200-day avg', fmt(quote.signal.stats.sma200)],
                      ['ATR (daily range)', fmt(quote.signal.stats.atr)],
                      ['52w high', fmt(quote.signal.stats.high52)],
                      ['52w low', fmt(quote.signal.stats.low52)],
                      ['Avg traded/day', `${fmt(quote.avgValue / 1e6, 1)}M ${quote.currency}`],
                      ...(quote.usd ? [[quote.usd.fxName, fmt(quote.usd.fxRate)] as const] : []),
                    ] as const).map(([l, v]) => (
                      <div key={l} className="flex justify-between border-b border-zinc-900 py-0.5"><span className="text-zinc-500">{l}</span><span>{v}</span></div>
                    ))}
                  </div>
                </Panel>
                <Panel title={`${quote.symbol} NEWS`}>
                  <div className="max-h-72 overflow-y-auto pr-1"><NewsList items={quote.news} max={15} /></div>
                </Panel>
              </div>
            </>
          )}
        </div>

        {/* RIGHT: world */}
        <div className="space-y-3">
          {regime && (
            <Panel title="MARKET REGIME">
              <div className={`text-lg font-bold mb-1 ${regime.label === 'RISK-ON' ? 'text-emerald-400' : regime.label === 'RISK-OFF' ? 'text-rose-400' : 'text-zinc-300'}`}>
                {regime.label} <span className="text-xs text-zinc-500">({regime.score.toFixed(2)})</span>
              </div>
              <ul className="text-xs text-zinc-400 space-y-0.5">{regime.reasons.map((r) => <li key={r}>• {r}</li>)}</ul>
              <p className="text-[11px] text-zinc-500 mt-2">
                {regime.label === 'RISK-ON' && 'Backdrop supports buying good setups.'}
                {regime.label === 'NEUTRAL' && 'Be selective; size positions smaller.'}
                {regime.label === 'RISK-OFF' && 'Defensive backdrop: favour cash, tighter stops, fewer new buys.'}
              </p>
            </Panel>
          )}

          {world && (
            <Panel title="WORLD PULSE">
              <div className="space-y-1">
                {Object.entries(world.topics).sort((a, b) => b[1].count - a[1].count).map(([t, v]) => (
                  <div key={t} className="flex items-center gap-2 text-xs">
                    <span className="w-36 truncate text-zinc-400">{t}</span>
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded relative">
                      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-600" />
                      <div
                        className={`absolute top-0 bottom-0 ${v.sentiment >= 0 ? 'bg-emerald-500 left-1/2' : 'bg-rose-500'}`}
                        style={v.sentiment >= 0 ? { width: `${v.sentiment * 50}%` } : { right: '50%', width: `${-v.sentiment * 50}%` }}
                      />
                    </div>
                    <span className="w-6 text-right text-zinc-500">{v.count}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel title="WORLD NEWS">
            <div className="flex flex-wrap gap-1 mb-2">
              {['All', ...Object.keys(world?.topics ?? {})].map((t) => (
                <button key={t} onClick={() => setTopicFilter(t)} className={`text-[10px] px-1.5 py-0.5 rounded border ${topicFilter === t ? 'border-amber-500 text-amber-400' : 'border-zinc-700 text-zinc-400'}`}>
                  {t}
                </button>
              ))}
            </div>
            <div className="max-h-[560px] overflow-y-auto pr-1"><NewsList items={headlines} max={60} /></div>
          </Panel>
        </div>
      </div>

      <footer className="px-4 pb-6 text-[10px] text-zinc-600 leading-relaxed">
        Signals are rules-based (trend, momentum, RSI, headline sentiment, market regime) and are for information only. They are not
        financial advice and cannot predict the future. Prices may be delayed. Never invest money you cannot afford to lose.
      </footer>
    </div>
  )
}

function PositionBox({
  symbol, price, signal, position, onSave,
}: {
  symbol: string
  price: number
  signal: Signal
  position?: Position
  onSave: (p: Position | null) => void
}) {
  const [shares, setShares] = useState(position ? String(position.shares) : '')
  const [entry, setEntry] = useState(position ? String(position.entry) : '')

  if (position) {
    const pl = (price - position.entry) * position.shares
    const plPct = ((price - position.entry) / position.entry) * 100
    const stop = Math.max(signal.levels.stopLoss, signal.levels.trailingStop)
    let advice: { text: string; cls: string }
    if (price <= stop) advice = { text: `Price is below your stop (${fmt(stop)}). Exit signal: consider selling.`, cls: 'text-rose-400' }
    else if (price >= signal.levels.takeProfit) advice = { text: 'Target reached. Consider taking some profit and raising your stop.', cls: 'text-emerald-400' }
    else if (signal.action === 'EXIT' || signal.action === 'REDUCE') advice = { text: 'Signal has turned negative. Consider trimming or tightening your stop.', cls: 'text-amber-300' }
    else advice = { text: `Hold. Get out if price closes below ${fmt(stop)}.`, cls: 'text-zinc-300' }
    return (
      <div className="border-t border-zinc-800 pt-2 text-xs space-y-1">
        <div className="text-indigo-300 font-bold">YOUR POSITION</div>
        <div className="flex justify-between"><span className="text-zinc-500">{position.shares} sh @ {fmt(position.entry)}</span><span className={tone(pl)}>{pl >= 0 ? '+' : ''}{fmt(pl)} ({pct(plPct)})</span></div>
        <div className={advice.cls}>{advice.text}</div>
        <button onClick={() => onSave(null)} className="text-[10px] text-zinc-500 hover:text-rose-400">remove position</button>
      </div>
    )
  }

  return (
    <form
      className="border-t border-zinc-800 pt-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault()
        const s = parseFloat(shares)
        const en = parseFloat(entry || String(price))
        if (s > 0 && en > 0) onSave({ shares: s, entry: en })
      }}
    >
      <div className="text-zinc-500 mb-1">Own {symbol}? Track it to get exit alerts:</div>
      <div className="flex gap-2">
        <input value={shares} onChange={(e) => setShares(e.target.value)} placeholder="shares" inputMode="decimal" className="w-20 bg-black border border-zinc-700 rounded px-1.5 py-1" />
        <input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={`entry ${fmt(price)}`} inputMode="decimal" className="flex-1 bg-black border border-zinc-700 rounded px-1.5 py-1" />
        <button className="px-2 bg-indigo-500 text-black font-bold rounded">TRACK</button>
      </div>
    </form>
  )
}
