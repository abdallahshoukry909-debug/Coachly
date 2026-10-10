// Server-side data fetchers. Free, key-less sources:
//  - Yahoo Finance chart API (prices), with Stooq CSV as a fallback
//  - Google News RSS (headlines)
import { scoreText, topicOf, type Topic } from './sentiment'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export interface Candles {
  symbol: string
  name: string
  currency: string
  price: number
  prevClose: number
  time: number[] // unix seconds
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
  source: 'yahoo' | 'stooq'
}

export interface Headline {
  title: string
  link: string
  source: string
  published: string // ISO
  sentiment: number // -1..1
  hits: string[]
  topic: Topic
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase()
  if (!/^[A-Z0-9.^=\-]{1,15}$/.test(s)) throw new Error('Invalid symbol')
  return s
}

async function fromYahoo(symbol: string, range: string): Promise<Candles> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`
  const json = JSON.parse(await fetchText(url))
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(json?.chart?.error?.description ?? 'No data')
  const q = r.indicators?.quote?.[0] ?? {}
  const ts: number[] = r.timestamp ?? []
  const c: Candles = {
    symbol,
    name: r.meta?.longName ?? r.meta?.shortName ?? symbol,
    currency: r.meta?.currency ?? 'USD',
    price: r.meta?.regularMarketPrice ?? NaN,
    prevClose: r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? NaN,
    time: [], open: [], high: [], low: [], close: [], volume: [],
    source: 'yahoo',
  }
  ts.forEach((t, i) => {
    const cl = q.close?.[i]
    if (cl == null) return
    c.time.push(t)
    c.close.push(cl)
    c.open.push(q.open?.[i] ?? cl)
    c.high.push(q.high?.[i] ?? cl)
    c.low.push(q.low?.[i] ?? cl)
    c.volume.push(q.volume?.[i] ?? 0)
  })
  if (!c.close.length) throw new Error('No candles')
  if (Number.isNaN(c.price)) c.price = c.close[c.close.length - 1]
  // Yahoo's chartPreviousClose is the close before the *range*; use the prior bar instead.
  if (c.close.length >= 2) c.prevClose = c.close[c.close.length - 2]
  return c
}

async function fromStooq(symbol: string): Promise<Candles> {
  // Stooq uses e.g. aapl.us for US tickers; indices/futures are not mapped.
  const s = symbol.includes('.') || symbol.startsWith('^') ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`)
  const rows = csv.trim().split('\n').slice(1).slice(-400)
  const c: Candles = {
    symbol, name: symbol, currency: 'USD', price: NaN, prevClose: NaN,
    time: [], open: [], high: [], low: [], close: [], volume: [], source: 'stooq',
  }
  for (const row of rows) {
    const [date, o, h, l, cl, v] = row.split(',')
    const close = parseFloat(cl)
    if (!date || Number.isNaN(close)) continue
    c.time.push(Math.floor(Date.parse(date) / 1000))
    c.open.push(parseFloat(o))
    c.high.push(parseFloat(h))
    c.low.push(parseFloat(l))
    c.close.push(close)
    c.volume.push(parseFloat(v) || 0)
  }
  if (!c.close.length) throw new Error('No candles')
  c.price = c.close[c.close.length - 1]
  c.prevClose = c.close[c.close.length - 2] ?? c.price
  return c
}

export async function getCandles(symbol: string, range = '2y'): Promise<Candles> {
  try {
    return await fromYahoo(symbol, range)
  } catch (err) {
    try {
      return await fromStooq(symbol)
    } catch {
      throw err
    }
  }
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim()
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? decode(m[1]) : ''
}

export function parseRss(xml: string): Headline[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []
  return items.map((item) => {
    let title = tag(item, 'title')
    const source = tag(item, 'source')
    // Google News appends " - Source" to titles.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
    const pub = tag(item, 'pubDate')
    const { score, hits } = scoreText(title)
    return {
      title,
      link: tag(item, 'link'),
      source,
      published: pub ? new Date(pub).toISOString() : new Date().toISOString(),
      sentiment: score,
      hits,
      topic: topicOf(title),
    }
  })
}

export type NewsLocale = 'en-US' | 'en-EG' | 'ar-EG'

const LOCALES: Record<NewsLocale, string> = {
  'en-US': 'hl=en-US&gl=US&ceid=US:en',
  'en-EG': 'hl=en&gl=EG&ceid=EG:en',
  'ar-EG': 'hl=ar&gl=EG&ceid=EG:ar',
}

export async function getNews(query: string, limit = 20, locale: NewsLocale = 'en-US'): Promise<Headline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:3d&${LOCALES[locale]}`
  const xml = await fetchText(url)
  const seen = new Set<string>()
  return parseRss(xml)
    .filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)))
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, limit)
}
