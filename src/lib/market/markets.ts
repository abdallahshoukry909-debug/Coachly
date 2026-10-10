// Per-market configuration: what the overview strip shows, which index and
// currency drive the regime, and which news feeds describe "the world".
import type { NewsLocale } from './data'

export type MarketId = 'us' | 'eg'

export interface MarketConfig {
  id: MarketId
  name: string
  regimeIndex: string
  regimeIndexName: string
  vix?: string
  fx?: string
  fxName?: string
  overview: { symbol: string; label: string }[]
  feeds: { query: string; locale: NewsLocale }[]
  defaultWatchlist: string[]
}

export const MARKETS: Record<MarketId, MarketConfig> = {
  us: {
    id: 'us',
    name: 'US',
    regimeIndex: 'SPY',
    regimeIndexName: 'S&P 500',
    vix: '^VIX',
    overview: [
      { symbol: 'SPY', label: 'S&P 500' },
      { symbol: 'QQQ', label: 'Nasdaq 100' },
      { symbol: 'DIA', label: 'Dow Jones' },
      { symbol: '^VIX', label: 'VIX (fear)' },
      { symbol: '^TNX', label: '10Y yield' },
      { symbol: 'GC=F', label: 'Gold' },
      { symbol: 'CL=F', label: 'Oil (WTI)' },
      { symbol: 'DX-Y.NYB', label: 'US Dollar' },
      { symbol: 'BTC-USD', label: 'Bitcoin' },
    ],
    feeds: [
      { query: 'stock market', locale: 'en-US' },
      { query: 'federal reserve interest rates', locale: 'en-US' },
      { query: 'geopolitics war sanctions markets', locale: 'en-US' },
      { query: 'economy inflation jobs report', locale: 'en-US' },
      { query: 'oil prices OPEC', locale: 'en-US' },
      { query: 'earnings results guidance', locale: 'en-US' },
    ],
    defaultWatchlist: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'TSLA', 'SPY'],
  },
  eg: {
    id: 'eg',
    name: 'Egypt',
    regimeIndex: '^CASE30',
    regimeIndexName: 'EGX30',
    fx: 'EGP=X',
    fxName: 'USD/EGP',
    overview: [
      { symbol: '^CASE30', label: 'EGX30' },
      { symbol: 'EGP=X', label: 'USD/EGP' },
      { symbol: 'GC=F', label: 'Gold (USD)' },
      { symbol: 'BZ=F', label: 'Brent oil' },
      { symbol: 'COMI.CA', label: 'CIB' },
      { symbol: 'SPY', label: 'S&P 500' },
      { symbol: '^VIX', label: 'VIX (global fear)' },
    ],
    feeds: [
      { query: 'Egyptian Exchange EGX stocks', locale: 'en-EG' },
      { query: 'Central Bank of Egypt interest rate', locale: 'en-EG' },
      { query: 'Egypt economy inflation IMF', locale: 'en-EG' },
      { query: 'Egyptian pound dollar exchange rate', locale: 'en-EG' },
      { query: 'Suez Canal revenue Red Sea', locale: 'en-EG' },
      { query: 'Gulf investment Egypt', locale: 'en-EG' },
      { query: 'البورصة المصرية', locale: 'ar-EG' },
      { query: 'البنك المركزي المصري الفائدة', locale: 'ar-EG' },
      { query: 'سعر الجنيه المصري الدولار', locale: 'ar-EG' },
      { query: 'التضخم في مصر', locale: 'ar-EG' },
    ],
    defaultWatchlist: ['COMI.CA', 'TMGH.CA', 'EAST.CA', 'HRHO.CA', 'FWRY.CA', 'ABUK.CA', 'SWDY.CA', 'ETEL.CA'],
  },
}

export function marketOf(symbol: string): MarketId {
  return symbol.endsWith('.CA') ? 'eg' : 'us'
}

export function parseMarket(raw: string | null): MarketId {
  return raw === 'eg' ? 'eg' : 'us'
}
