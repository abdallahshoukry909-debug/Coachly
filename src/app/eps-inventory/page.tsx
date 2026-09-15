import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import EpsInventoryApp from './EpsInventoryApp'

export default async function EpsInventoryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login?next=/eps-inventory')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_eps_admin')
    .eq('id', user.id)
    .single()

  if (!profile?.is_eps_admin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6 text-center">
        <div>
          <div className="text-4xl mb-3">🔒</div>
          <h1 className="text-lg font-bold text-gray-900 mb-1">No access</h1>
          <p className="text-sm text-gray-500">
            This account isn&apos;t authorized for EPS Inventory. Ask an admin to grant access.
          </p>
        </div>
      </div>
    )
  }

  return <EpsInventoryApp />
}
