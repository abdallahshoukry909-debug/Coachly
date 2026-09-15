East Pharma Factory — inventory, production, and orders tool for East Pharmaceutical Services, built on [Next.js](https://nextjs.org) and [Supabase](https://supabase.com).

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser. Signed-out visitors land on the login page; the app itself lives at `/eps-inventory` and is only visible to accounts with `is_eps_admin = true` in the `profiles` table.

## Database

Migrations live in `supabase/migrations/`. Run them against your Supabase project's SQL editor in order:

- `001_initial.sql` — legacy schema from an earlier version of this app (kept, unused).
- `002_eps_inventory.sql` — the `eps_inventory_data` table and `is_eps_admin` flag this app actually uses.

## Deploy

Deployed on [Vercel](https://vercel.com). See the [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for details.
