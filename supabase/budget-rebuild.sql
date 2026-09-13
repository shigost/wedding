-- ============================================================================
--  Budget rebuild: wishlist + collaborative items + shared target/changelog.
--  Run AFTER roles-and-rls.sql (it uses can_read/can_edit/has_role_row).
--  Idempotent. Run in the Supabase SQL editor.
-- ============================================================================

-- ── 0. How many rows will the wishlist migration move? (run this first) ──────
-- select count(*) as rows_moving_to_wishlist from public.budget_items;

-- ── 1. Extend budget_items ───────────────────────────────────────────────────
alter table public.budget_items add column if not exists state         text not null default 'active';   -- 'wishlist' | 'active'
alter table public.budget_items add column if not exists from_wishlist boolean not null default false;   -- promoted out of the wishlist
alter table public.budget_items add column if not exists total         numeric;
alter table public.budget_items add column if not exists deposit_paid  numeric not null default 0;
alter table public.budget_items add column if not exists balance_due   numeric;                          -- editable; defaults to total - deposit_paid in the UI
alter table public.budget_items add column if not exists notes         text;
alter table public.budget_items add column if not exists payer         text;
alter table public.budget_items add column if not exists due_date      date;
alter table public.budget_items add column if not exists vendor_id     bigint references public.vendors(id) on delete set null;
alter table public.budget_items add column if not exists vendor_name   text;                             -- snapshot so finance-only users see it without vendors access
alter table public.budget_items add column if not exists doc_url       text;                             -- path in the private budget-docs bucket
alter table public.budget_items add column if not exists doc_name      text;
alter table public.budget_items add column if not exists created_by    uuid default auth.uid();
alter table public.budget_items add column if not exists updated_by    uuid;
alter table public.budget_items add column if not exists updated_at    timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_items_state_chk') then
    alter table public.budget_items add constraint budget_items_state_chk check (state in ('wishlist','active'));
  end if;
end $$;

-- Stamp updated_by/updated_at on every update.
create or replace function public.touch_budget_item() returns trigger
language plpgsql security definer set search_path = public as $$
begin new.updated_by := auth.uid(); new.updated_at := now(); return new; end $$;
drop trigger if exists budget_items_touch on public.budget_items;
create trigger budget_items_touch before update on public.budget_items
  for each row execute function public.touch_budget_item();

-- ── 2. Migrate placeholder rows → wishlist (keep name+cat; drop guessed money) ─
-- The legacy amount/status columns were NOT NULL; relax that so we can clear them.
alter table public.budget_items alter column amount drop not null;
alter table public.budget_items alter column status drop not null;
update public.budget_items
   set state = 'wishlist', amount = null, status = null
 where state <> 'wishlist';  -- (on first run, that's every existing row)

-- ── 3. Shared master budget (target) — budget-editors may change it ───────────
create table if not exists public.budget_meta (
  id         int primary key default 1 check (id = 1),   -- singleton row
  target     numeric not null default 60000,
  updated_by uuid,
  updated_at timestamptz default now()
);
insert into public.budget_meta (id, target) values (1, 60000) on conflict (id) do nothing;
alter table public.budget_meta enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='budget_meta' loop
    execute format('drop policy if exists %I on public.budget_meta', r.policyname);
  end loop;
end $$;
create policy budget_meta_sel on public.budget_meta for select using (public.can_read('budget'));
create policy budget_meta_ins on public.budget_meta for insert with check (public.can_edit('budget'));
create policy budget_meta_upd on public.budget_meta for update using (public.can_edit('budget')) with check (public.can_edit('budget'));

-- ── 4. Collaborative change log (target + item changes: who / from → to / when) ─
create table if not exists public.budget_changelog (
  id          uuid primary key default gen_random_uuid(),
  label       text,               -- 'Master budget' or the item name/field
  from_amount numeric,
  to_amount   numeric,
  reason      text,
  changed_by  uuid default auth.uid(),
  created_at  timestamptz default now()
);
alter table public.budget_changelog enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='public' and tablename='budget_changelog' loop
    execute format('drop policy if exists %I on public.budget_changelog', r.policyname);
  end loop;
end $$;
create policy budget_changelog_sel on public.budget_changelog for select using (public.can_read('budget'));
create policy budget_changelog_ins on public.budget_changelog for insert with check (public.can_edit('budget'));
-- (no update/delete: an audit log is append-only)

-- ── 5. Display-name directory (id → display_name only; no emails/roles/perms) ──
create or replace function public.get_display_names()
returns table(user_id uuid, display_name text)
language sql stable security definer set search_path = public as $$
  select user_id, display_name from public.user_roles where public.has_role_row()
$$;

-- ── 6. Private bucket for quote PDFs, gated by budget permission ───────────────
insert into storage.buckets (id, name, public) values ('budget-docs','budget-docs', false)
  on conflict (id) do nothing;
drop policy if exists budget_docs_sel on storage.objects;
drop policy if exists budget_docs_ins on storage.objects;
drop policy if exists budget_docs_upd on storage.objects;
drop policy if exists budget_docs_del on storage.objects;
create policy budget_docs_sel on storage.objects for select using (bucket_id = 'budget-docs' and public.can_read('budget'));
create policy budget_docs_ins on storage.objects for insert with check (bucket_id = 'budget-docs' and public.can_edit('budget'));
create policy budget_docs_upd on storage.objects for update using (bucket_id = 'budget-docs' and public.can_edit('budget')) with check (bucket_id = 'budget-docs' and public.can_edit('budget'));
create policy budget_docs_del on storage.objects for delete using (bucket_id = 'budget-docs' and public.can_edit('budget'));

-- ── 7. Live sync: add the new tables to the realtime publication ─────────────
do $$ begin
  begin alter publication supabase_realtime add table public.budget_meta; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.budget_changelog; exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- ── Verify (optional) ─────────────────────────────────────────────────────────
-- select state, count(*) from public.budget_items group by state;   -- expect all in 'wishlist' on first run
-- select * from public.budget_meta;
