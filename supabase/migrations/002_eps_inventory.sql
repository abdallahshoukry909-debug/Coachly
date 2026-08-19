-- EPS Factory Inventory tool: durable storage + strict access control.
--
-- Access is restricted to an explicit allowlist of admins (is_eps_admin = true
-- on the caller's profile row), not just "any logged-in Coachly user" — Coachly
-- itself is a public marketplace with open signup, so that would otherwise let
-- any random visitor who creates an account read/write factory inventory data.
--
-- After you sign up / log in once at /auth/login with your own account, grant
-- yourself (and anyone else on the team) access by running in the Supabase
-- SQL editor:
--   update profiles set is_eps_admin = true where email = 'you@example.com';

alter table profiles add column if not exists is_eps_admin boolean not null default false;

-- Single JSON-blob table, keyed by a storage key (mirrors the app's previous
-- key/value storage so the port could be close to 1:1). Kept intentionally
-- simple: one row holds the whole inventory/production/orders state.
create table if not exists eps_inventory_data (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table eps_inventory_data enable row level security;

create policy "EPS admins can read inventory data" on eps_inventory_data
  for select using (
    exists (select 1 from profiles where id = auth.uid() and is_eps_admin = true)
  );

create policy "EPS admins can insert inventory data" on eps_inventory_data
  for insert with check (
    exists (select 1 from profiles where id = auth.uid() and is_eps_admin = true)
  );

create policy "EPS admins can update inventory data" on eps_inventory_data
  for update using (
    exists (select 1 from profiles where id = auth.uid() and is_eps_admin = true)
  );

-- Deliberately no delete policy: the app itself never needs to delete a row
-- (it always upserts the one JSON blob), so nobody can wipe this table from
-- the app even by accident. Only the Supabase dashboard / service role can.
