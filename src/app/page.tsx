import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col">
      {/* Hero Section */}
      <section className="bg-gradient-to-br from-green-50 to-emerald-100 py-24 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-6">
            Find Your <span className="text-green-600">Perfect Coach</span>
          </h1>
          <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
            Connect with expert coaches across fitness, business, life, and more.
            Achieve your goals with personalized 1-on-1 coaching sessions.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/coaches"
              className="bg-green-600 text-white px-8 py-4 rounded-lg text-lg font-semibold hover:bg-green-700 transition-colors shadow-md"
            >
              Find a Coach
            </Link>
            <Link
              href="/auth/signup"
              className="bg-white text-green-600 border-2 border-green-600 px-8 py-4 rounded-lg text-lg font-semibold hover:bg-green-50 transition-colors"
            >
              Become a Coach
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 px-4 bg-white">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">
            Why Choose Coachly?
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center p-6 rounded-xl bg-green-50 border border-green-100">
              <div className="w-14 h-14 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">Expert Coaches</h3>
              <p className="text-gray-600">
                All coaches are vetted and verified. Browse profiles, specialties, and real client reviews.
              </p>
            </div>
            <div className="text-center p-6 rounded-xl bg-green-50 border border-green-100">
              <div className="w-14 h-14 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">Easy Booking</h3>
              <p className="text-gray-600">
                Book sessions in seconds. Pick a time that works for you and your coach.
              </p>
            </div>
            <div className="text-center p-6 rounded-xl bg-green-50 border border-green-100">
              <div className="w-14 h-14 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">Track Progress</h3>
              <p className="text-gray-600">
                Keep track of all your sessions, goals, and achievements in one place.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 px-4 bg-green-600">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Ready to Start Your Journey?</h2>
          <p className="text-green-100 text-lg mb-8">
            Join thousands of people achieving their goals with expert coaching.
          </p>
          <Link
            href="/auth/signup"
            className="bg-white text-green-600 px-8 py-4 rounded-lg text-lg font-semibold hover:bg-green-50 transition-colors inline-block"
          >
            Get Started Free
          </Link>
        </div>
      </section>
    </div>
  );
}
