-- Sales call tracker: clients grouped into sections, with a call log per client

create table sales_clients (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  section text not null check (section in ('wema', 'silica')),
  name text not null,
  phone text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table sales_calls (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references sales_clients(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  outcome text not null check (outcome in ('cold', 'warm', 'hot', 'no_answer')),
  feedback text,
  call_date date not null default current_date,
  created_at timestamptz default now()
);

create index sales_clients_user_id_idx on sales_clients(user_id);
create index sales_clients_section_idx on sales_clients(user_id, section);
create index sales_calls_client_id_idx on sales_calls(client_id);
create index sales_calls_user_id_idx on sales_calls(user_id);

-- Row Level Security: each rep only ever sees their own clients and calls
alter table sales_clients enable row level security;
alter table sales_calls enable row level security;

create policy "Users manage own clients" on sales_clients for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own calls" on sales_calls for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Keep sales_clients.updated_at current whenever a new call is logged,
-- so the client list can show "last called" without a second query.
create or replace function touch_sales_client_on_call()
returns trigger as $$
begin
  update sales_clients
  set updated_at = now()
  where id = new.client_id;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_sales_call_inserted
  after insert on sales_calls
  for each row execute function touch_sales_client_on_call();
