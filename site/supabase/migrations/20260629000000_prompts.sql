-- Frequently used prompts: reusable clipboard snippets shown in a bookmark-page tab.
create table if not exists samuelh_prompts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists samuelh_prompts_sort_idx on samuelh_prompts (sort_order);
