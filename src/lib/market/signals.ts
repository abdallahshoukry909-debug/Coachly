// Combines technicals, news sentiment and the overall market regime into a
// single, explainable signal. This is a rules-based model, not a prediction.
import { atr, last, macd, pctChange, rsi, sma } from './indicators'
import type { Candles } from './data'

export type Action = 'BUY' | 'ACCUMULATE' | 'HOLD' | 'REDUCE' | 'EXIT'

export interface Reason {
  label: string
  points: number
  detail: string
}

export interface Signal {
  action: Action
  score: number // -100..100
  reasons: Reason[]
  events: string[]
  levels: {
    entry: number
    stopLoss: number
    takeProfit: number
    trailingStop: number
  }
  stats: {
    change1d: number
    change1m: number
    change3m: number
    change1y: number
    rsi: number
    sma20: number
    sma50: number
    sma200: number
    macdHist: number
    high52: number
    low52: number
    fromHigh: number
    volatility: number // annualized %
    atr: number
  }
}

export interface Regime {
  score: number // -1..1
  label: 'RISK-ON' | 'NEUTRAL' | 'RISK-OFF'
  reasons: string[]
}

function changeOver(close: number[], bars: number): number {
  if (close.length <= bars) return NaN
  return pctChange(close[close.length - 1 - bars], close[close.length - 1])
}

function crossedWithin(a: number[], b: number[], bars: number): 'up' | 'down' | null {
  for (let i = a.length - 1; i > a.length - 1 - bars && i > 0; i--) {
    if ([a[i], b[i], a[i - 1], b[i - 1]].some(Number.isNaN)) return null
    if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return 'up'
    if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return 'down'
  }
  return null
}

export function computeSignal(c: Candles, newsSentiment: number, regime: Regime | null): Signal {
  const close = c.close
  const price = c.price
  const s20 = sma(close, 20)
  const s50 = sma(close, 50)
  const s200 = sma(close, 200)
  const r = rsi(close, 14)
  const m = macd(close)
  const a = atr(c.high, c.low, close, 14)

  const sma20 = last(s20)
  const sma50 = last(s50)
  const sma200 = last(s200)
  const rsiNow = last(r)
  const hist = last(m.hist)
  const histPrev = m.hist[m.hist.length - 2]
  const atrNow = last(a)

  const year = close.slice(-252)
  const high52 = Math.max(...year)
  const low52 = Math.min(...year)

  const rets = close.slice(-64).map((v, i, arr) => (i ? Math.log(v / arr[i - 1]) : 0)).slice(1)
  const mean = rets.reduce((x, y) => x + y, 0) / (rets.length || 1)
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length || 1)
  const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100

  // Chandelier exit: highest close of last 22 bars minus 3 ATR.
  const trailingStop = Math.max(...close.slice(-22)) - 3 * atrNow

  const reasons: Reason[] = []
  const add = (label: string, points: number, detail: string) => reasons.push({ label, points, detail })

  // 1. Trend (max ±30)
  if (!Number.isNaN(sma200)) {
    add('Long-term trend', price > sma200 ? 10 : -10,
      `Price ${price > sma200 ? 'above' : 'below'} 200-day average (${sma200.toFixed(2)})`)
    if (!Number.isNaN(sma50)) {
      add('Golden/death cross', sma50 > sma200 ? 10 : -10,
        `50-day avg ${sma50 > sma200 ? 'above' : 'below'} 200-day avg`)
    }
  }
  if (!Number.isNaN(sma50)) {
    add('Medium-term trend', price > sma50 ? 10 : -10,
      `Price ${price > sma50 ? 'above' : 'below'} 50-day average (${sma50.toFixed(2)})`)
  }

  // 2. Momentum (max ±20)
  if (!Number.isNaN(hist)) {
    const rising = hist > histPrev
    const pts = hist > 0 ? (rising ? 10 : 5) : rising ? -3 : -10
    add('MACD momentum', pts, `MACD histogram ${hist > 0 ? 'positive' : 'negative'} and ${rising ? 'rising' : 'falling'}`)
  }
  const ch3m = changeOver(close, 63)
  if (!Number.isNaN(ch3m)) {
    add('3-month return', Math.max(-10, Math.min(10, ch3m / 2)), `${ch3m >= 0 ? '+' : ''}${ch3m.toFixed(1)}% over 3 months`)
  }

  // 3. RSI (max ±15)
  if (!Number.isNaN(rsiNow)) {
    const uptrend = price > sma200
    if (rsiNow < 30) add('RSI oversold', uptrend ? 15 : 5, `RSI ${rsiNow.toFixed(0)} — sold off hard${uptrend ? ' inside an uptrend (dip-buy zone)' : ', but trend is down'}`)
    else if (rsiNow > 75) add('RSI overbought', -15, `RSI ${rsiNow.toFixed(0)} — stretched, pullback risk`)
    else if (rsiNow > 70) add('RSI overbought', -8, `RSI ${rsiNow.toFixed(0)} — getting stretched`)
    else add('RSI', 0, `RSI ${rsiNow.toFixed(0)} — neutral`)
  }

  // 4. News (max ±15)
  add('News sentiment', Math.round(newsSentiment * 15),
    `Recent headlines are ${newsSentiment > 0.15 ? 'positive' : newsSentiment < -0.15 ? 'negative' : 'mixed/neutral'} (${newsSentiment.toFixed(2)})`)

  // 5. Market regime (max ±20)
  if (regime) {
    add('Market regime', Math.round(regime.score * 20), `Overall market is ${regime.label}`)
  }

  let score = Math.max(-100, Math.min(100, Math.round(reasons.reduce((s, x) => s + x.points, 0))))

  const events: string[] = []
  const cross = crossedWithin(s50, s200, 10)
  if (cross === 'up') events.push('Golden cross in the last 2 weeks (50-day crossed above 200-day)')
  if (cross === 'down') events.push('Death cross in the last 2 weeks (50-day crossed below 200-day)')
  const brokeStop = price < trailingStop
  if (brokeStop) events.push(`Price closed below the trailing stop (${trailingStop.toFixed(2)}) — trend may be breaking`)
  if (price >= high52 * 0.99) events.push('Trading at a 52-week high')
  if (price <= low52 * 1.01) events.push('Trading at a 52-week low')

  let action: Action =
    score >= 45 ? 'BUY' : score >= 20 ? 'ACCUMULATE' : score > -20 ? 'HOLD' : score > -45 ? 'REDUCE' : 'EXIT'
  // A broken trailing stop overrides bullish readings: protect capital first.
  if (brokeStop && (action === 'BUY' || action === 'ACCUMULATE' || action === 'HOLD')) {
    action = 'REDUCE'
    score = Math.min(score, -20)
  }

  // Entry: buy now if strong, otherwise wait for a pullback to the 20-day average.
  const entry = action === 'BUY' || Number.isNaN(sma20) ? price : Math.min(price, sma20)
  const stopLoss = Math.max(entry - 2 * atrNow, Number.isNaN(sma200) ? 0 : Math.min(sma200, entry - atrNow))
  const takeProfit = entry + 2 * (entry - stopLoss) // 2:1 reward-to-risk

  return {
    action,
    score,
    reasons,
    events,
    levels: { entry, stopLoss, takeProfit, trailingStop },
    stats: {
      change1d: pctChange(c.prevClose, price),
      change1m: changeOver(close, 21),
      change3m: ch3m,
      change1y: changeOver(close, 252),
      rsi: rsiNow,
      sma20, sma50, sma200,
      macdHist: hist,
      high52, low52,
      fromHigh: pctChange(high52, price),
      volatility,
      atr: atrNow,
    },
  }
}

export interface RegimeInputs {
  index: Candles | null
  indexName: string
  vix?: Candles | null
  // USD per-unit exchange rate for a local currency (e.g. EGP=X). A rising
  // rate means the local currency is weakening.
  fx?: Candles | null
  fxName?: string
  worldSentiment: number
}

export function computeRegime({ index, indexName, vix, fx, fxName, worldSentiment }: RegimeInputs): Regime {
  let score = 0
  const reasons: string[] = []
  if (index) {
    const s200 = last(sma(index.close, 200))
    const s50 = last(sma(index.close, 50))
    if (!Number.isNaN(s200)) {
      const above = index.price > s200
      score += above ? 0.35 : -0.35
      reasons.push(`${indexName} ${above ? 'above' : 'below'} its 200-day average`)
    }
    if (!Number.isNaN(s50)) {
      const above = index.price > s50
      score += above ? 0.15 : -0.15
      reasons.push(`${indexName} ${above ? 'above' : 'below'} its 50-day average`)
    }
  }
  if (vix) {
    const v = vix.price
    if (v < 15) { score += 0.25; reasons.push(`VIX ${v.toFixed(1)} — calm markets`) }
    else if (v < 20) { score += 0.1; reasons.push(`VIX ${v.toFixed(1)} — normal`) }
    else if (v < 28) { score -= 0.2; reasons.push(`VIX ${v.toFixed(1)} — elevated fear`) }
    else { score -= 0.4; reasons.push(`VIX ${v.toFixed(1)} — panic levels (contrarian buyers watch here)`) }
  }
  if (fx) {
    const ch = changeOver(fx.close, 21)
    if (!Number.isNaN(ch)) {
      // Sharp local-currency weakness drives capital flight and inflation.
      if (ch > 5) { score -= 0.3; reasons.push(`${fxName} up ${ch.toFixed(1)}% in a month — currency under heavy pressure`) }
      else if (ch > 1.5) { score -= 0.15; reasons.push(`${fxName} up ${ch.toFixed(1)}% in a month — currency weakening`) }
      else if (ch < -1.5) { score += 0.15; reasons.push(`${fxName} down ${(-ch).toFixed(1)}% in a month — currency strengthening`) }
      else { score += 0.05; reasons.push(`${fxName} stable (${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% in a month)`) }
    }
  }
  score += worldSentiment * 0.25
  reasons.push(`News tone ${worldSentiment >= 0 ? '+' : ''}${worldSentiment.toFixed(2)}`)
  score = Math.max(-1, Math.min(1, score))
  return { score, label: score > 0.25 ? 'RISK-ON' : score < -0.25 ? 'RISK-OFF' : 'NEUTRAL', reasons }
}

// Return over roughly `days` calendar days, measured in USD instead of the
// local currency, using a USD/local exchange-rate series (e.g. EGP=X).
export function usdReturn(c: Candles, fx: Candles, days: number): number {
  const at = (series: Candles, t: number) => {
    for (let i = series.time.length - 1; i >= 0; i--) if (series.time[i] <= t) return series.close[i]
    return NaN
  }
  const tEnd = c.time[c.time.length - 1]
  const tStart = tEnd - days * 86400
  const p0 = at(c, tStart)
  const fx0 = at(fx, tStart)
  const fx1 = at(fx, tEnd)
  if ([p0, fx0, fx1].some(Number.isNaN)) return NaN
  return pctChange(p0 / fx0, c.price / fx1)
}

// Average daily traded value (price x volume) over the last 20 sessions.
export function avgTradedValue(c: Candles, bars = 20): number {
  const n = Math.min(bars, c.close.length)
  if (!n) return NaN
  let sum = 0
  for (let i = c.close.length - n; i < c.close.length; i++) sum += c.close[i] * c.volume[i]
  return sum / n
}
