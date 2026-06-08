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
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <div className="bg-white px-5 pt-12 pb-4 sticky top-0 z-10 border-b border-gray-100">
        <h1 className="text-xl font-bold text-gray-900">Find Coaches</h1>

        {/* Search bar */}
        <form className="mt-3" method="get">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              name="q"
              defaultValue={params.q ?? ''}
              placeholder="Search coaches..."
              className="w-full pl-9 pr-4 py-2.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:bg-white transition-colors"
            />
          </div>

          {/* Category chips */}
          <div className="flex gap-2 mt-3 overflow-x-auto pb-1 no-scrollbar">
            <a
              href="/coaches"
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                !params.category || params.category === 'all'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              All
            </a>
            {CATEGORIES.map((c) => (
              <a
                key={c}
                href={`/coaches?category=${c}${params.q ? `&q=${params.q}` : ''}`}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  params.category === c
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {c}
              </a>
            ))}
          </div>
        </form>
      </div>

      {/* Coach list */}
      <div className="flex-1 px-4 py-4">
        {error && (
          <div className="bg-red-50 text-red-700 rounded-2xl p-4 mb-4 text-sm">
            Failed to load coaches. Please try again.
          </div>
        )}

        {coachesList.length === 0 ? (
          <div className="text-center py-16">
            <span className="text-5xl">🔍</span>
            <p className="text-gray-500 mt-4 font-medium">No coaches found</p>
            {hasFilters && (
              <a href="/coaches" className="text-green-600 text-sm mt-2 inline-block">
                Clear filters
              </a>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-gray-400 mb-3">
              {coachesList.length} coach{coachesList.length !== 1 ? 'es' : ''} found
            </p>
            <div className="flex flex-col gap-3">
              {coachesList.map((coach) => (
                <CoachCard key={coach.id} coach={coach} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
