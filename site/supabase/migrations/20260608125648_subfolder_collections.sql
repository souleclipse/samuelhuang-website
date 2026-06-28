-- Add parent_id for nested collection support
alter table samuelh_bookmark_collections
  add column if not exists parent_id uuid references samuelh_bookmark_collections(id) on delete cascade;

create index if not exists samuelh_bookmark_collections_parent_id_idx
  on samuelh_bookmark_collections(parent_id);

-- Seed sub-collections using slugs to resolve parent IDs
with parents as (
  select id, slug from samuelh_bookmark_collections
)
insert into samuelh_bookmark_collections (slug, name, icon, sort_order, parent_id) values
  -- N8N & Automation
  ('n8n-jr',       'JR',                '🤖', 11, (select id from parents where slug='n8n-automation')),
  ('n8n-noclick',  'NoClick AI',        '🤖', 12, (select id from parents where slug='n8n-automation')),

  -- Client Work
  ('cw-andrew',    'Andrew',            '💼', 21, (select id from parents where slug='client-work')),
  ('cw-gvrt',      'GVRT',             '💼', 22, (select id from parents where slug='client-work')),
  ('cw-email',     'Email Marketing',   '📧', 23, (select id from parents where slug='client-work')),
  ('cw-hosting',   'Hosting & VA',      '🖥️', 24, (select id from parents where slug='client-work')),

  -- HARO & Link Building
  ('haro-haro',    'HARO',             '🔗', 31, (select id from parents where slug='haro-link-building')),
  ('haro-wlb',     'Web Link Broker',   '🔗', 32, (select id from parents where slug='haro-link-building')),

  -- SEO / Client Sites
  ('seo-archseo',  'ArchSEO',          '📈', 41, (select id from parents where slug='seo-client-sites')),
  ('seo-healthpbn','Health PBN',        '📈', 42, (select id from parents where slug='seo-client-sites')),
  ('seo-gml',      'GML',              '📈', 43, (select id from parents where slug='seo-client-sites')),

  -- Software & Tools
  ('sw-gsa',       'GSA',              '🛠️', 51, (select id from parents where slug='software-tools')),
  ('sw-zimmwriter','ZimmWriter',        '🛠️', 52, (select id from parents where slug='software-tools')),
  ('sw-social',    'Social Media Panel','🛠️', 53, (select id from parents where slug='software-tools')),

  -- Personal
  ('p-health',     'Health & Fitness', '🏃', 91, (select id from parents where slug='personal')),
  ('p-workout',    'Workout',          '💪', 92, (select id from parents where slug='personal')),
  ('p-thailand',   'Thailand',         '🇹🇭', 93, (select id from parents where slug='personal')),
  ('p-motivation', 'Motivation',       '🌟', 94, (select id from parents where slug='personal'))
on conflict (slug) do nothing;
