// Pure technical-indicator helpers. Each returns an array aligned with the
// input, using NaN where there is not yet enough data.

export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

// Wilder's RSI.
export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast)
  const s = ema(values, slow)
  const line = values.map((_, i) => f[i] - s[i])
  const firstValid = line.findIndex((v) => !Number.isNaN(v))
  const sig: number[] = new Array(values.length).fill(NaN)
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), signal)
    tail.forEach((v, i) => (sig[firstValid + i] = v))
  }
  const hist = line.map((v, i) => v - sig[i])
  return { line, signal: sig, hist }
}

// Average True Range (Wilder).
export function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  const out: number[] = new Array(close.length).fill(NaN)
  const tr = close.map((_, i) =>
    i === 0
      ? high[i] - low[i]
      : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))
  )
  if (tr.length < period) return out
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

export function last(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (!Number.isNaN(values[i])) return values[i]
  return NaN
}

export function pctChange(from: number, to: number): number {
  return from === 0 ? 0 : ((to - from) / from) * 100
}
