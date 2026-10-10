// Lightweight keyword-based headline sentiment and topic tagging.
// Deliberately simple and transparent: every score can be traced to words.

const POSITIVE: Record<string, number> = {
  surge: 2, surges: 2, soar: 2, soars: 2, rally: 2, rallies: 2, record: 1, beat: 2, beats: 2,
  jump: 1.5, jumps: 1.5, gain: 1, gains: 1, rise: 1, rises: 1, climbs: 1, upgrade: 2, upgraded: 2,
  growth: 1, strong: 1, bullish: 2, optimism: 1.5, rebound: 1.5, recovers: 1.5, recovery: 1.5,
  ceasefire: 2, peace: 1.5, deal: 1, agreement: 1, 'rate cut': 2, 'cuts rates': 2, easing: 1,
  stimulus: 1.5, profit: 1, outperform: 1.5, buyback: 1, approval: 1, approved: 1, expands: 1,
  cooling: 1, 'soft landing': 2, hiring: 1, boom: 1.5, breakthrough: 1.5,
  inflows: 1.5, 'imf approves': 2, disbursement: 1, 'foreign investment': 1, 'eases inflation': 1.5,
  // Arabic
  'ارتفاع': 1, 'يرتفع': 1, 'صعود': 1.5, 'مكاسب': 1.5, 'ارباح': 1, 'أرباح': 1, 'نمو': 1, 'قفزة': 2,
  'خفض الفائدة': 2, 'تثبيت الفائدة': 0.5, 'استثمارات': 1, 'تدفقات': 1.5, 'انتعاش': 1.5, 'اتفاق': 1,
  'تراجع التضخم': 1.5, 'قياسي': 1,
}

const NEGATIVE: Record<string, number> = {
  plunge: 2, plunges: 2, crash: 3, crashes: 3, tumble: 2, tumbles: 2, slump: 2, slumps: 2,
  fall: 1, falls: 1, drop: 1, drops: 1, sink: 1.5, sinks: 1.5, miss: 2, misses: 2, downgrade: 2,
  downgraded: 2, recession: 2.5, inflation: 1, war: 2.5, invasion: 3, attack: 2, attacks: 2, strike: 1,
  strikes: 1, missile: 2, sanctions: 1.5, tariff: 1.5, tariffs: 1.5, bearish: 2, fear: 1.5,
  fears: 1.5, selloff: 2, 'sell-off': 2, layoffs: 1.5, bankruptcy: 3, default: 2, crisis: 2.5,
  lawsuit: 1, probe: 1, investigation: 1, 'rate hike': 2, 'hikes rates': 2, warning: 1.5,
  warns: 1.5, weak: 1, losses: 1.5, volatility: 1, shutdown: 1.5, escalation: 2, escalates: 2,
  conflict: 1.5, unemployment: 1, contraction: 1.5, 'trade war': 2.5, pandemic: 2, outbreak: 2,
  devaluation: 2, devalues: 2, 'black market': 1.5, shortage: 1.5, outflows: 1.5, 'debt crisis': 2.5,
  // Arabic
  'انخفاض': 1, 'هبوط': 1.5, 'تراجع': 1, 'خسائر': 1.5, 'خسارة': 1.5, 'حرب': 2.5, 'تضخم': 1,
  'رفع الفائدة': 2, 'أزمة': 2.5, 'ازمة': 2.5, 'تعويم': 1.5, 'عجز': 1, 'ركود': 2.5, 'انهيار': 3,
  'تصعيد': 2, 'عقوبات': 1.5, 'نقص': 1.5,
}

export type Topic =
  | 'Geopolitics'
  | 'Central Banks'
  | 'Economy'
  | 'Energy & Commodities'
  | 'Tech'
  | 'Earnings'
  | 'Crypto'
  | 'Markets'

// Arabic and Egypt-specific terms are checked first. (\b does not work with
// Arabic script, so these patterns match substrings.)
const TOPICS: [Topic, RegExp][] = [
  ['Central Banks', /البنك المركزي|الفائدة|central bank of egypt|\bcbe\b/i],
  ['Economy', /التضخم|تضخم|صندوق النقد|الجنيه|الدولار|سعر الصرف|\bimf\b|egyptian pound|devaluation|exchange rate/i],
  ['Geopolitics', /قناة السويس|غزة|حرب|suez|gaza|red sea|houthi/i],
  ['Energy & Commodities', /النفط|نفط|الغاز|الذهب|القمح/],
  ['Markets', /البورصة|egx/i],
  ['Geopolitics', /\b(war|military|missile|invasion|sanction|nato|china|russia|ukraine|israel|iran|taiwan|election|ceasefire|conflict|troops|border)\b/i],
  ['Central Banks', /\b(fed|federal reserve|powell|ecb|bank of england|boj|interest rate|rate cut|rate hike|fomc|monetary)\b/i],
  ['Economy', /\b(gdp|inflation|cpi|jobs|payroll|unemployment|recession|consumer|retail sales|pmi|housing)\b/i],
  ['Energy & Commodities', /\b(oil|opec|crude|gas|gold|silver|copper|wheat|commodit)/i],
  ['Earnings', /\b(earnings|revenue|quarter|guidance|eps|profit|results)\b/i],
  ['Crypto', /\b(bitcoin|crypto|ethereum|btc|blockchain)\b/i],
  ['Tech', /\b(ai|chip|semiconductor|nvidia|apple|microsoft|google|meta|tesla|software)\b/i],
]

export function topicOf(text: string): Topic {
  for (const [t, re] of TOPICS) if (re.test(text)) return t
  return 'Markets'
}

export interface Scored {
  score: number // -1 .. +1
  hits: string[]
}

// Longest phrases first, so "rate cut" or "تراجع التضخم" is scored as a whole
// and its parts ("cut", "تراجع") are not counted again.
const LEXICON: [string, number][] = [
  ...Object.entries(POSITIVE),
  ...Object.entries(NEGATIVE).map(([w, v]): [string, number] => [w, -v]),
].sort((a, b) => b[0].length - a[0].length)

export function scoreText(text: string): Scored {
  let lower = ` ${text.toLowerCase()} `
  let raw = 0
  const hits: string[] = []
  for (const [word, w] of LEXICON) {
    const isAscii = /^[\x00-\x7f]+$/.test(word)
    // \b does not work with Arabic script, so Arabic terms match as substrings
    // (they often carry attached prefixes like ال).
    const re = isAscii ? new RegExp(`(?<=[^a-z])${word.replace(/[-]/g, '\\-')}(?=[^a-z])`) : null
    const found = re ? re.test(lower) : lower.includes(word)
    if (!found) continue
    raw += w
    hits.push(w > 0 ? `+${word}` : `-${word}`)
    lower = re ? lower.replace(re, ' ') : lower.replace(word, ' ')
  }
  // squash to -1..1
  return { score: Math.tanh(raw / 3), hits }
}

export function averageScore(items: { sentiment: number }[]): number {
  if (!items.length) return 0
  return items.reduce((a, b) => a + b.sentiment, 0) / items.length
}
