import type { NextRequest } from 'next/server'
import { getCandles, getNews, normalizeSymbol, type Candles } from '@/lib/market/data'
import { averageScore } from '@/lib/market/sentiment'
import { avgTradedValue, computeSignal, usdReturn, type Regime } from '@/lib/market/signals'
import { cached } from '@/lib/market/cache'
import { MARKETS, marketOf } from '@/lib/market/markets'

// Below this average daily traded value, signals get noisy and exits can be hard.
const THIN_LIQUIDITY: Record<string, number> = { USD: 5_000_000, EGP: 10_000_000 }

// "Commercial International Bank (Egypt) S.A.E." -> "Commercial International Bank"
function newsName(name: string): string {
  return name
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(S\.?A\.?E\.?|Inc\.?|Corp(oration)?\.?|Ltd\.?|PLC|Co\.?|Company|Holding(s)?|Group|S\.?A\.?)\b/gi, ' ')
    .replace(/[,.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const candles = (symbol: string) => cached(`candles:${symbol}`, 60_000, () => getCandles(symbol))

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  let symbol: string
  try {
    symbol = normalizeSymbol(params.get('symbol') ?? '')
  } catch {
    return Response.json({ error: 'Invalid symbol' }, { status: 400 })
  }

  const regimeScore = parseFloat(params.get('regime') ?? '')
  const regime: Regime | null = Number.isNaN(regimeScore)
    ? null
    : {
        score: Math.max(-1, Math.min(1, regimeScore)),
        label: regimeScore > 0.25 ? 'RISK-ON' : regimeScore < -0.25 ? 'RISK-OFF' : 'NEUTRAL',
        reasons: [],
      }

  const market = MARKETS[marketOf(symbol)]

  try {
    const [c, fx] = await Promise.all([
      candles(symbol),
      market.fx ? candles(market.fx).catch((): Candles | null => null) : Promise.resolve(null),
    ])

    // Search news by company name: tickers like COMI.CA find almost nothing.
    const name = newsName(c.name)
    const query = market.id === 'eg'
      ? `"${name || symbol.replace('.CA', '')}" Egypt`
      : name && name !== symbol ? `"${name}" OR ${symbol} stock` : `${symbol} stock`
    const news = await cached(`news:${market.id}:${query}`, 5 * 60_000, () =>
      getNews(query, 15, market.id === 'eg' ? 'en-EG' : 'en-US')
    ).catch(() => [])

    const signal = computeSignal(c, averageScore(news), regime)

    const avgValue = avgTradedValue(c)
    const thin = THIN_LIQUIDITY[c.currency]
    if (thin && avgValue > 0 && avgValue < thin) {
      signal.events.push(
        `Thinly traded: ~${(avgValue / 1e6).toFixed(1)}M ${c.currency}/day on average. Signals are less reliable and selling quickly may be hard.`
      )
    }

    // For local-currency markets, show returns in USD too: a falling currency
    // can make prices rise while real value drops.
    const usd = fx
      ? { m1: usdReturn(c, fx, 30), m3: usdReturn(c, fx, 91), y1: usdReturn(c, fx, 365), fxName: market.fxName, fxRate: fx.price }
      : null
    if (usd && !Number.isNaN(usd.y1) && signal.stats.change1y > 0 && usd.y1 < 0) {
      signal.events.push(
        `Up ${signal.stats.change1y.toFixed(0)}% in ${c.currency} over a year but ${usd.y1.toFixed(0)}% in USD: gains are mostly currency weakness.`
      )
    }

    const n = 260
    return Response.json({
      symbol,
      market: market.id,
      name: c.name,
      currency: c.currency,
      price: c.price,
      source: c.source,
      chart: { time: c.time.slice(-n), close: c.close.slice(-n) },
      signal,
      usd,
      avgValue,
      news,
      updated: new Date().toISOString(),
    })
  } catch (err) {
    return Response.json(
      { error: `Could not load ${symbol}: ${err instanceof Error ? err.message : 'unknown error'}` },
      { status: 502 }
    )
  }
}
