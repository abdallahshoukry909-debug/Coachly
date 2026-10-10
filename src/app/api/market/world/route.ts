import type { NextRequest } from 'next/server'
import { getCandles, getNews, type Candles, type Headline } from '@/lib/market/data'
import { averageScore } from '@/lib/market/sentiment'
import { computeRegime } from '@/lib/market/signals'
import { cached } from '@/lib/market/cache'
import { MARKETS, parseMarket } from '@/lib/market/markets'

export async function GET(request: NextRequest) {
  const market = MARKETS[parseMarket(request.nextUrl.searchParams.get('market'))]
  const candles = (symbol: string) => cached(`candles:${symbol}`, 60_000, () => getCandles(symbol))
  const settled = async (symbol?: string): Promise<Candles | null> =>
    symbol ? candles(symbol).catch(() => null) : null

  const [overviewResults, newsResults, index, vix, fx] = await Promise.all([
    Promise.allSettled(market.overview.map((o) => candles(o.symbol))),
    Promise.allSettled(
      market.feeds.map((f) => cached(`news:${f.locale}:${f.query}`, 5 * 60_000, () => getNews(f.query, 12, f.locale)))
    ),
    settled(market.regimeIndex),
    settled(market.vix),
    settled(market.fx),
  ])

  const overview = market.overview.map((o, i) => {
    const r = overviewResults[i]
    if (r.status !== 'fulfilled') return { ...o, price: null, change: null, spark: [] }
    const c = r.value
    return {
      ...o,
      price: c.price,
      change: c.prevClose ? ((c.price - c.prevClose) / c.prevClose) * 100 : null,
      spark: c.close.slice(-30),
    }
  })

  const seen = new Set<string>()
  const headlines: Headline[] = newsResults
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)))
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, 80)

  const worldSentiment = averageScore(headlines)
  const regime = computeRegime({
    index,
    indexName: market.regimeIndexName,
    vix,
    fx,
    fxName: market.fxName,
    worldSentiment,
  })

  const byTopic: Record<string, { count: number; sentiment: number }> = {}
  for (const h of headlines) {
    const t = (byTopic[h.topic] ??= { count: 0, sentiment: 0 })
    t.count++
    t.sentiment += h.sentiment
  }
  for (const t of Object.values(byTopic)) t.sentiment /= t.count

  return Response.json({
    market: market.id,
    overview,
    regime,
    worldSentiment,
    topics: byTopic,
    headlines,
    errors: overviewResults.filter((r) => r.status === 'rejected').length,
    updated: new Date().toISOString(),
  })
}
