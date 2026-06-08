-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Profiles table (extends auth.users)
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  full_name text,
  avatar_url text,
  role text not null check (role in ('coach', 'client')),
  bio text,
  created_at timestamptz default now()
);

-- Coach details
create table coaches (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) on delete cascade unique,
  category text,
  price_per_session numeric(10,2),
  location text,
  years_experience integer,
  rating_avg float default 0,
  total_reviews integer default 0,
  is_verified boolean default false,
  created_at timestamptz default now()
);

-- Sessions / bookings
create table sessions (
  id uuid primary key default uuid_generate_v4(),
  coach_id uuid references coaches(id) on delete cascade,
  client_id uuid references profiles(id) on delete cascade,
  scheduled_at timestamptz not null,
  duration_minutes integer default 60,
  status text not null default 'pending' check (status in ('pending','accepted','completed','cancelled')),
  notes text,
  price numeric(10,2),
  created_at timestamptz default now()
);

-- Reviews
create table reviews (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid references sessions(id) on delete cascade unique,
  reviewer_id uuid references profiles(id) on delete cascade,
  coach_id uuid references coaches(id) on delete cascade,
  rating integer not null check (rating >= 1 and rating <= 5),
  comment text,
  created_at timestamptz default now()
);

-- Row Level Security
alter table profiles enable row level security;
alter table coaches enable row level security;
alter table sessions enable row level security;
alter table reviews enable row level security;

-- Profile policies
create policy "Profiles are viewable by everyone" on profiles for select using (true);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- Coach policies
create policy "Coaches are viewable by everyone" on coaches for select using (true);
create policy "Coaches can insert own record" on coaches for insert with check (
  auth.uid() = (select id from profiles where id = coaches.user_id)
);
create policy "Coaches can update own record" on coaches for update using (
  auth.uid() = (select id from profiles where id = coaches.user_id)
);

-- Session policies
create policy "Users can view own sessions" on sessions for select using (
  auth.uid() = client_id
  or auth.uid() = (select p.id from profiles p join coaches c on c.id = sessions.coach_id where p.id = c.user_id limit 1)
);
create policy "Clients can create sessions" on sessions for insert with check (auth.uid() = client_id);
create policy "Participants can update sessions" on sessions for update using (
  auth.uid() = client_id
  or auth.uid() = (select p.id from profiles p join coaches c on c.id = sessions.coach_id where p.id = c.user_id limit 1)
);

-- Review policies
create policy "Reviews are public" on reviews for select using (true);
create policy "Clients can create reviews" on reviews for insert with check (auth.uid() = reviewer_id);

-- Function to update coach rating_avg and total_reviews after a review is inserted
create or replace function update_coach_rating()
returns trigger as $$
begin
  update coaches
  set
    rating_avg = (
      select coalesce(avg(rating), 0)
      from reviews
      where coach_id = new.coach_id
    ),
    total_reviews = (
      select count(*)
      from reviews
      where coach_id = new.coach_id
    )
  where id = new.coach_id;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_review_inserted
  after insert on reviews
  for each row execute function update_coach_rating();
