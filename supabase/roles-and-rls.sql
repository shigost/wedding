-- ============================================================================
--  Roles, per-user permission overrides, and RLS enforcement.
--  Run once in the Supabase SQL editor. Idempotent (safe to re-run).
--
--  Model: a role sets defaults; per-user JSONB overrides sit on top.
--  Effective permission = override[section] ?? role_default[role][section] ?? 'none'.
--  A user with no row, or role = NULL (pending), gets 'none' on everything.
-- ============================================================================

-- ── 1. user_roles ───────────────────────────────────────────────────────────
create table if not exists public.user_roles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text check (role in ('owner','collaborator','financial','vendor')),  -- NULL = pending / no access
  permissions  jsonb not null default '{}'::jsonb,   -- e.g. {"budget":"none","guests":"read"}
  created_at   timestamptz default now()
);

-- ── 2. Role defaults (mirrored in the app's JS) ──────────────────────────────
create or replace function public.role_defaults(r text) returns jsonb
language sql immutable as $$
  select case r
    when 'owner'        then '{"venues":"edit","scenarios":"edit","budget":"edit","guests":"edit","tasks":"edit","itinerary":"edit","mood_board":"edit","couple_gallery":"edit","vendors":"edit"}'::jsonb
    when 'collaborator' then '{"venues":"edit","scenarios":"edit","mood_board":"edit","tasks":"edit","itinerary":"edit","guests":"edit"}'::jsonb
    when 'financial'    then '{"budget":"edit","scenarios":"read","venues":"read","mood_board":"read"}'::jsonb
    when 'vendor'       then '{"venues":"read","mood_board":"read","couple_gallery":"read"}'::jsonb
    else '{}'::jsonb
  end
$$;

-- ── 3. Effective-permission resolvers (SECURITY DEFINER: read only the caller's
--       own row via auth.uid(); no recursion, RLS-safe) ─────────────────────────
create or replace function public.perm_level(section text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select permissions->>section         from public.user_roles where user_id = auth.uid()),
    (select role_defaults(role)->>section from public.user_roles where user_id = auth.uid()),
    'none')
$$;
create or replace function public.can_read(s text) returns boolean
language sql stable security definer set search_path = public as $$ select public.perm_level(s) in ('read','edit') $$;
create or replace function public.can_edit(s text) returns boolean
language sql stable security definer set search_path = public as $$ select public.perm_level(s) = 'edit' $$;
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$ select exists(select 1 from public.user_roles where user_id = auth.uid() and role = 'owner') $$;
create or replace function public.has_role_row() returns boolean
language sql stable security definer set search_path = public as $$ select exists(select 1 from public.user_roles where user_id = auth.uid() and role is not null) $$;

-- ── 4. New auth users surface as PENDING (role NULL = no access) ──────────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_roles(user_id, email, role)
  values (new.id, new.email, null)
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 5. Section-table policies (drops EVERY existing policy first, then applies
--       select=read, insert/update/delete=edit) ───────────────────────────────
do $$
declare
  t text; sec text; r record;
  section_tables jsonb := '{
    "venues":"venues","archived_venues":"venues",
    "scenarios":"scenarios","scenario_items":"scenarios","scenario_types":"scenarios",
    "budget_items":"budget","guests":"guests","timeline_tasks":"tasks",
    "itinerary_items":"itinerary","vendors":"vendors","mood_images":"mood_board"
  }';
begin
  for t, sec in select key, value from jsonb_each_text(section_tables) loop
    if to_regclass('public.'||t) is null then raise notice 'SKIP missing table: %', t; continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', r.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select using (public.can_read(%L))', t||'_sel', t, sec);
    execute format('create policy %I on public.%I for insert with check (public.can_edit(%L))', t||'_ins', t, sec);
    execute format('create policy %I on public.%I for update using (public.can_edit(%L)) with check (public.can_edit(%L))', t||'_upd', t, sec, sec);
    execute format('create policy %I on public.%I for delete using (public.can_edit(%L))', t||'_del', t, sec);
  end loop;
end $$;

-- ── 6. Global / admin tables ─────────────────────────────────────────────────
-- user_roles: read own row (so the app can compute the caller's UI) or any if owner; only owners write.
alter table public.user_roles enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='user_roles' loop
    execute format('drop policy if exists %I on public.user_roles', r.policyname);
  end loop;
end $$;
create policy user_roles_sel on public.user_roles for select using (user_id = auth.uid() or public.is_owner());
create policy user_roles_ins on public.user_roles for insert with check (public.is_owner());
create policy user_roles_upd on public.user_roles for update using (public.is_owner()) with check (public.is_owner());
create policy user_roles_del on public.user_roles for delete using (public.is_owner());

-- themes + app_config: read requires an assigned role (pending users see nothing); only owners write.
do $$
declare t text; r record;
begin
  foreach t in array array['themes','app_config'] loop
    if to_regclass('public.'||t) is null then raise notice 'SKIP missing table: %', t; continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for r in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', r.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select using (public.has_role_row())', t||'_sel', t);
    execute format('create policy %I on public.%I for insert with check (public.is_owner())', t||'_ins', t);
    execute format('create policy %I on public.%I for update using (public.is_owner()) with check (public.is_owner())', t||'_upd', t);
    execute format('create policy %I on public.%I for delete using (public.is_owner())', t||'_del', t);
  end loop;
end $$;

-- wedding_dates: read requires a role; owners + anyone with itinerary-edit may change dates.
do $$ declare r record; begin
  if to_regclass('public.wedding_dates') is not null then
    alter table public.wedding_dates enable row level security;
    for r in select policyname from pg_policies where schemaname='public' and tablename='wedding_dates' loop
      execute format('drop policy if exists %I on public.wedding_dates', r.policyname);
    end loop;
    create policy wedding_dates_sel on public.wedding_dates for select using (public.has_role_row());
    create policy wedding_dates_ins on public.wedding_dates for insert with check (public.is_owner() or public.can_edit('itinerary'));
    create policy wedding_dates_upd on public.wedding_dates for update using (public.is_owner() or public.can_edit('itinerary')) with check (public.is_owner() or public.can_edit('itinerary'));
    create policy wedding_dates_del on public.wedding_dates for delete using (public.is_owner() or public.can_edit('itinerary'));
  else raise notice 'SKIP missing table: wedding_dates'; end if;
end $$;

-- ── 7. Seed the owners. FILL IN Taleran's email before running. ───────────────
insert into public.user_roles(user_id, email, role)
select id, email, 'owner' from auth.users
where email in (
  'OWNER_1_EMAIL_HERE@example.com',   -- <<< your login email (fill in locally; do not commit)
  'OWNER_2_EMAIL_HERE@example.com'    -- <<< Taleran's login email (fill in locally; do not commit)
)
on conflict (user_id) do update set role = 'owner';


-- ============================================================================
--  VERIFICATION — run these AFTER the script and read the output.
-- ============================================================================

-- (A) RLS must be enabled (relrowsecurity = true) on every managed table:
-- select relname, relrowsecurity as rls_enabled
-- from pg_class
-- where relnamespace = 'public'::regnamespace
--   and relname in ('venues','archived_venues','scenarios','scenario_items','scenario_types',
--                   'budget_items','guests','timeline_tasks','itinerary_items','vendors',
--                   'mood_images','wedding_dates','themes','app_config','user_roles')
-- order by relname;

-- (B) Full policy list per table — every row's qual/with_check should reference
--     can_read / can_edit / is_owner / has_role_row / auth.uid(), never plain 'true':
-- select tablename, policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('venues','archived_venues','scenarios','scenario_items','scenario_types',
--                     'budget_items','guests','timeline_tasks','itinerary_items','vendors',
--                     'mood_images','wedding_dates','themes','app_config','user_roles')
-- order by tablename, cmd, policyname;

-- (C) RED FLAGS — this must return ZERO rows. Any hit is a leftover
--     unconditional / authenticated-only policy silently granting full access:
-- select tablename, policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('venues','archived_venues','scenarios','scenario_items','scenario_types',
--                     'budget_items','guests','timeline_tasks','itinerary_items','vendors',
--                     'mood_images','wedding_dates','themes','app_config','user_roles')
--   and (
--     coalesce(qual, '')       in ('true')
--     or coalesce(with_check,'') in ('true')
--     or (qual is null and with_check is null)                 -- policy with no condition at all
--     or qual ilike '%role = ''authenticated''%'               -- old "authenticated full access" shape
--   );

-- (D) Tables in public that have NO policies but DO have RLS on (would deny all)
--     or RLS OFF (would allow all to anon key) — either is worth eyeballing:
-- select c.relname,
--        c.relrowsecurity as rls_on,
--        count(p.policyname) as policies
-- from pg_class c
-- left join pg_policies p on p.schemaname='public' and p.tablename=c.relname
-- where c.relnamespace='public'::regnamespace and c.relkind='r'
-- group by c.relname, c.relrowsecurity
-- order by c.relname;
