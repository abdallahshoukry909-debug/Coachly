import Link from "next/link";

const CATEGORIES = [
  { label: "Fitness", emoji: "💪" },
  { label: "Business", emoji: "💼" },
  { label: "Life", emoji: "🌱" },
  { label: "Language", emoji: "🗣️" },
  { label: "Career", emoji: "🚀" },
  { label: "Nutrition", emoji: "🥗" },
  { label: "Mindfulness", emoji: "🧘" },
  { label: "Other", emoji: "✨" },
]

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white px-5 pt-12 pb-6">
        <div className="flex items-center justify-between mb-1">
          <span className="text-2xl font-bold text-gray-900">Coachly</span>
          <div className="flex gap-2">
            <Link
              href="/auth/login"
              className="text-sm font-medium text-gray-600 px-4 py-2 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              Login
            </Link>
            <Link
              href="/auth/signup"
              className="text-sm font-medium text-white bg-green-600 px-4 py-2 rounded-full hover:bg-green-700 transition-colors"
            >
              Sign Up
            </Link>
          </div>
        </div>
        <p className="text-gray-500 text-sm">Find your perfect coach</p>
      </div>

      {/* Hero Banner */}
      <div className="mx-4 mt-4 bg-gradient-to-br from-green-500 to-emerald-600 rounded-3xl p-6 text-white">
        <p className="text-green-100 text-sm font-medium mb-1">Get started today</p>
        <h2 className="text-2xl font-bold mb-4 leading-tight">
          Achieve your goals with expert 1-on-1 coaching
        </h2>
        <Link
          href="/coaches"
          className="inline-flex items-center gap-2 bg-white text-green-700 px-5 py-2.5 rounded-full font-semibold text-sm hover:bg-green-50 transition-colors"
        >
          Browse Coaches
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {/* Quick Actions */}
      <div className="px-4 mt-6">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Quick Actions</h3>
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/coaches"
            className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow"
          >
            <div className="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center text-xl">🔍</div>
            <span className="font-semibold text-gray-900 text-sm">Find a Coach</span>
            <span className="text-xs text-gray-500">Browse all coaches</span>
          </Link>
          <Link
            href="/auth/signup?role=coach"
            className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow"
          >
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center text-xl">🎯</div>
            <span className="font-semibold text-gray-900 text-sm">Become a Coach</span>
            <span className="text-xs text-gray-500">Start earning today</span>
          </Link>
        </div>
      </div>

      {/* Categories */}
      <div className="px-4 mt-6">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Browse by Category</h3>
        <div className="grid grid-cols-4 gap-3">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.label}
              href={`/coaches?category=${cat.label}`}
              className="bg-white rounded-2xl p-3 border border-gray-100 shadow-sm flex flex-col items-center gap-1.5 hover:shadow-md transition-shadow"
            >
              <span className="text-2xl">{cat.emoji}</span>
              <span className="text-[10px] font-medium text-gray-700 text-center leading-tight">{cat.label}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* Why Coachly */}
      <div className="px-4 mt-6 mb-8">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Why Coachly?</h3>
        <div className="flex flex-col gap-3">
          {[
            { icon: "✅", title: "Verified Coaches", desc: "All coaches are reviewed and vetted" },
            { icon: "⚡", title: "Easy Booking", desc: "Book a session in under a minute" },
            { icon: "⭐", title: "Real Reviews", desc: "Honest ratings from real clients" },
          ].map((item) => (
            <div key={item.title} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm flex items-center gap-4">
              <span className="text-2xl">{item.icon}</span>
              <div>
                <p className="font-semibold text-gray-900 text-sm">{item.title}</p>
                <p className="text-xs text-gray-500">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
