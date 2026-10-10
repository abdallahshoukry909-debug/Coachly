// Tiny in-memory TTL cache so repeated dashboard refreshes don't hammer
// upstream data sources. Per server instance; good enough for personal use.
const store = new Map<string, { at: number; value: Promise<unknown> }>()

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
  const value = fn().catch((err) => {
    store.delete(key)
    throw err
  })
  store.set(key, { at: Date.now(), value })
  return value
}
