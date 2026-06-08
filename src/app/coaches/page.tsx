import { createClient } from '@/lib/supabase/server'
import CoachCard from '@/components/CoachCard'
import type { Coach } from '@/lib/types'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['Fitness', 'Business', 'Life', 'Language', 'Career', 'Nutrition', 'Mindfulness', 'Other']

interface SearchParams {
  q?: string
  category?: string
  maxPrice?: string
  minRating?: string
}

export default async function CoachesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('coaches')
    .select('*, profiles(*)')
    .order('rating_avg', { ascending: false })

  if (params.category && params.category !== 'all') {
    query = query.eq('category', params.category)
  }

  if (params.maxPrice) {
    query = query.lte('price_per_session', parseFloat(params.maxPrice))
  }

  if (params.minRating) {
    query = query.gte('rating_avg', parseFloat(params.minRating))
  }

  const { data: coaches, error } = await query
  let coachesList = (coaches ?? []) as Coach[]

  // Text search by coach name (client-side since full_name is in joined table)
  if (params.q) {
    const q = params.q.toLowerCase()
    coachesList = coachesList.filter(
      (c) =>
        c.profiles?.full_name?.toLowerCase().includes(q) ||
        c.category?.toLowerCase().includes(q)
    )
  }

  const hasFilters = params.q || params.category || params.maxPrice || params.minRating

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Browse Coaches</h1>
        <p className="text-gray-600 mt-1">Find the perfect coach for your goals</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Filters Sidebar */}
        <aside className="lg:w-64 flex-shrink-0">
          <form className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-5 sticky top-20">
            <h2 className="font-semibold text-gray-900">Search & Filter</h2>

            {/* Text search */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
              <input
                type="text"
                name="q"
                defaultValue={params.q ?? ''}
                placeholder="Name or category..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select
                name="category"
                defaultValue={params.category ?? 'all'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="all">All Categories</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Max price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max Price ($)</label>
              <input
                type="number"
                name="maxPrice"
                defaultValue={params.maxPrice ?? ''}
                placeholder="e.g. 200"
                min="0"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            {/* Min rating */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Minimum Rating</label>
              <select
                name="minRating"
                defaultValue={params.minRating ?? ''}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">Any rating</option>
                <option value="4">4+ ★★★★</option>
                <option value="3">3+ ★★★</option>
                <option value="2">2+ ★★</option>
              </select>
            </div>

            <button
              type="submit"
              className="w-full bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 transition-colors font-medium text-sm"
            >
              Apply Filters
            </button>

            {hasFilters && (
              <a
                href="/coaches"
                className="block text-center text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Clear all filters
              </a>
            )}
          </form>
        </aside>

        {/* Coaches Grid */}
        <div className="flex-1">
          {error && (
            <div className="bg-red-50 text-red-700 rounded-lg p-4 mb-4 text-sm">
              Failed to load coaches. Please try again.
            </div>
          )}

          {coachesList.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
              <svg className="w-12 h-12 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <p className="text-gray-500 text-lg">No coaches found.</p>
              {hasFilters && (
                <a href="/coaches" className="text-green-600 hover:underline mt-2 inline-block text-sm">
                  Clear filters
                </a>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">
                {coachesList.length} coach{coachesList.length !== 1 ? 'es' : ''} found
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
                {coachesList.map((coach) => (
                  <CoachCard key={coach.id} coach={coach} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
