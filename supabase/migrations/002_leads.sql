-- Lead generation table for factory sales tracking
create table leads (
  id uuid primary key default uuid_generate_v4(),
  company_name text not null,
  company_type text not null check (company_type in ('pharmaceutical', 'veterinary', 'other')),
  products text[] default '{}',
  contact_name text,
  contact_email text,
  contact_phone text,
  website text,
  city text,
  address text,
  status text not null default 'prospect' check (status in ('prospect', 'contacted', 'interested', 'negotiating', 'customer', 'lost')),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table leads enable row level security;

create policy "Leads viewable by authenticated users" on leads for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert leads" on leads for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update leads" on leads for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete leads" on leads for delete using (auth.role() = 'authenticated');

-- Auto-update updated_at on changes
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger leads_updated_at
  before update on leads
  for each row execute function set_updated_at();

-- Seed: Egyptian pharmaceutical companies that use flip-off caps / sachets
insert into leads (company_name, company_type, products, city, status) values
  ('Rameda Pharmaceuticals', 'pharmaceutical', array['flip_off_caps'], 'Alexandria', 'prospect'),
  ('Pharco Pharmaceuticals', 'pharmaceutical', array['flip_off_caps', 'sachets'], 'Alexandria', 'prospect'),
  ('EIPICO', 'pharmaceutical', array['flip_off_caps'], '10th of Ramadan City', 'prospect'),
  ('Amriya Pharmaceutical Industries', 'pharmaceutical', array['flip_off_caps'], 'Alexandria', 'prospect'),
  ('Sigma Pharmaceutical Industries', 'pharmaceutical', array['flip_off_caps', 'sachets'], 'Quesna', 'prospect'),
  ('Medical Union Pharmaceuticals (MUP)', 'pharmaceutical', array['flip_off_caps'], '6th of October City', 'prospect'),
  ('Eva Pharma', 'pharmaceutical', array['flip_off_caps', 'sachets'], '6th of October City', 'prospect'),
  ('Global Napi Pharmaceuticals', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('CID (Chemical Industries Development)', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('SEDICO', 'pharmaceutical', array['flip_off_caps'], '6th of October City', 'prospect'),
  ('BORG Pharmaceuticals', 'pharmaceutical', array['flip_off_caps'], '6th of October City', 'prospect'),
  ('Gypto Pharma', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Minapharm', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Memphis Pharmaceuticals', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Marcyrl Pharmaceutical Industries', 'pharmaceutical', array['flip_off_caps'], '10th of Ramadan City', 'prospect'),
  ('Alexandria Company for Pharmaceuticals (ACP)', 'pharmaceutical', array['flip_off_caps'], 'Alexandria', 'prospect'),
  ('Kahira Pharmaceuticals', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Al Andalous Medical Company', 'pharmaceutical', array['flip_off_caps', 'sachets'], 'Cairo', 'prospect'),
  ('Sanofi Egypt', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Novartis Egypt', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Pfizer Egypt', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('GlaxoSmithKline Egypt', 'pharmaceutical', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Atco Pharma', 'pharmaceutical', array['flip_off_caps', 'sachets'], 'Cairo', 'prospect'),
  -- Veterinary companies that use flip-off caps for vials
  ('MEVAC (Middle East for Vaccines)', 'veterinary', array['flip_off_caps'], '10th of Ramadan City', 'prospect'),
  ('Biovac Egypt', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('CEVA Egypt', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Intervet Egypt (MSD Animal Health)', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Phibro Animal Health Egypt', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Egyptian Vaccine Company (EGYVAC)', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('Veterinary Serum & Vaccine Research Institute', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect'),
  ('ABIC Egypt', 'veterinary', array['flip_off_caps'], 'Cairo', 'prospect');
