-- KeelRace: Migration 0009
--   * family_key becomes sequential and alphanumeric-only (e.g. CMP0001,
--     CMP0002, ...) instead of a random 5-character suffix. A small
--     per-project counter table + an atomic increment function generates
--     it -- safe under concurrent generation calls (the UPDATE...RETURNING
--     takes a row lock on that project's single counter row, so two
--     concurrent generations for the same project serialize correctly
--     instead of racing to the same number).

create table component_key_counters (
  project_id uuid primary key references projects(id) on delete cascade,
  next_value int not null default 1
);
-- Internal counter, not user-facing data -- RLS enabled with no direct
-- client policies; only reachable through the SECURITY DEFINER function
-- below, same pattern as debt_item_status_log's insert-only trigger.
alter table component_key_counters enable row level security;

create or replace function next_component_key(p_project_id uuid) returns text as $$
declare
  v_val int;
begin
  insert into component_key_counters (project_id) values (p_project_id)
  on conflict (project_id) do nothing;

  update component_key_counters
    set next_value = next_value + 1
    where project_id = p_project_id
    returning next_value - 1 into v_val;

  return 'CMP' || lpad(v_val::text, 4, '0');
end;
$$ language plpgsql security definer;

grant execute on function next_component_key(uuid) to authenticated;

-- Backfill existing components (from 0008's backfill, which used the row's
-- own id as family_key -- a long string) onto the new sequential scheme,
-- oldest first so numbering is at least chronologically sensible. Migration
-- backfills are a legitimate reason to bypass the identity-immutability
-- trigger; disabling it for this one statement (not from the app) is the
-- standard, safe way to do that.
alter table components disable trigger trg_guard_component_identity;

do $$
declare
  r record;
begin
  for r in
    select id, project_id from components
    where length(family_key) > 10 -- 0008's id-derived keys are long ("CMP" + 32 hex chars); real ones are short
    order by project_id, created_at
  loop
    update components set family_key = next_component_key(r.project_id) where id = r.id;
  end loop;
end $$;

alter table components enable trigger trg_guard_component_identity;
