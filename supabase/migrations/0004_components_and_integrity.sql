-- KeelRace: Migration 0004
--   * A real `components` table -- the spec treats "component" as one
--     consistent thing across HLD/code/team-boundaries/drift; we'd been
--     approximating it two different, inconsistent ways. This fixes that.
--   * design_documents becomes genuinely append-only (NFR-3): content,
--     version and type are now immutable after insert, not just `status`.
--   * FR-4.4 -> FR-9.2: resolving drift as log_as_debt now actually creates
--     the debt_items row instead of only setting a field.
--   * FR-5.2: decisions can be marked provisional with a revisit_condition.
--   * NFR-5: artifacts modified since their last drift evaluation are now
--     flagged, giving the "unevaluated merge" acceptance criterion teeth.
--   * review_gates.decided_at is now actually required on a decision.

-- ============================================================
-- Real Component entity
-- ============================================================
create table components (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  hld_document_id uuid not null references design_documents(id) on delete cascade,
  name text not null,
  description text,
  needs_detail boolean not null default false,
  created_at timestamptz not null default now()
);
alter table components enable row level security;
create policy components_rw on components for all using (is_project_member(project_id));

-- design_documents: separate "which HLD produced this LLD" (unchanged
-- semantics, kept as-is) from "which component this LLD/decision is about"
-- (new, precise FK -- previously conflated with hld_component_id, which
-- actually only ever pointed at the parent HLD's own id).
alter table design_documents add column if not exists component_id uuid references components(id);

-- decision_rationales: which component a decision shaped (nullable --
-- some decisions are cross-cutting and don't belong to one component).
alter table decision_rationales add column if not exists component_id uuid references components(id);

-- Repoint the FKs that were standing in with decision_rationales.id as a
-- proxy for "component". Existing data can't be safely auto-migrated (a
-- decision is not a component), so these columns are dropped and recreated
-- pointing at components; re-link via the UI after this migration if you
-- have pre-existing rows.
alter table code_artifacts drop column if exists design_component_id;
alter table code_artifacts add column design_component_id uuid references components(id);

alter table team_boundaries drop column if exists design_component_id;
alter table team_boundaries add column design_component_id uuid references components(id);

alter table deprecation_records drop column if exists design_component_id;
alter table deprecation_records add column design_component_id uuid references components(id);

-- ============================================================
-- NFR-3, for real this time: design_documents.content/version/type become
-- immutable after insert. Only status-adjacent bookkeeping fields may
-- change. approve_design_document() still works (it only ever touches
-- status/approved_by/approved_at).
-- ============================================================
create or replace function guard_design_document_immutability() returns trigger as $$
begin
  if NEW.content is distinct from OLD.content
     or NEW.version is distinct from OLD.version
     or NEW.type is distinct from OLD.type
     or NEW.requirement_set_id is distinct from OLD.requirement_set_id then
    raise exception 'design_documents.content/version/type/requirement_set_id are immutable after insert (NFR-3) -- generate a new version instead';
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_guard_design_document_immutability
  before update on design_documents
  for each row execute function guard_design_document_immutability();

-- ============================================================
-- FR-4.4 -> FR-9.2: log_as_debt now actually creates the debt_items row.
-- ============================================================
create or replace function create_debt_on_log_as_debt() returns trigger as $$
declare
  v_project_id uuid;
  v_path text;
begin
  if NEW.resolution = 'log_as_debt' and (OLD.resolution is distinct from 'log_as_debt') then
    select ca.project_id, ca.path into v_project_id, v_path from code_artifacts ca where ca.id = NEW.code_artifact_id;
    insert into debt_items (project_id, drift_event_id, description, status)
    values (v_project_id, NEW.id, format('Logged as debt from drift on %s (%s, %s severity)', v_path, NEW.classification, coalesce(NEW.severity::text, 'unknown')), 'open');
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_create_debt_on_log_as_debt
  after update on drift_events
  for each row execute function create_debt_on_log_as_debt();

-- ============================================================
-- NFR-5: flag artifacts modified since their last drift evaluation.
-- Requires knowing "modified" -- track it via content_hash changes.
-- ============================================================
alter table code_artifacts add column if not exists last_modified_at timestamptz not null default now();

create or replace function touch_code_artifact_modified() returns trigger as $$
begin
  if NEW.content_hash is distinct from OLD.content_hash then
    NEW.last_modified_at = now();
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_touch_code_artifact_modified
  before update on code_artifacts
  for each row execute function touch_code_artifact_modified();

-- View: artifacts modified more recently than their last drift evaluation
-- (or never evaluated at all) -- the "unevaluated merge" case NFR-5 wants
-- flagged. Exposed as a view so health-report (and RLS) can just query it.
create or replace view unevaluated_artifacts as
select ca.id as code_artifact_id, ca.project_id, ca.path, ca.last_modified_at,
       (select max(de.detected_at) from drift_events de where de.code_artifact_id = ca.id) as last_evaluated_at
from code_artifacts ca
where ca.type = 'file'
  and (
    (select max(de.detected_at) from drift_events de where de.code_artifact_id = ca.id) is null
    or ca.last_modified_at > (select max(de.detected_at) from drift_events de where de.code_artifact_id = ca.id)
  );

-- views don't inherit RLS from base tables automatically in all setups;
-- security_invoker makes it evaluate RLS as the querying user.
alter view unevaluated_artifacts set (security_invoker = true);

-- ============================================================
-- FR-5.2: allow marking a decision provisional with a revisit_condition.
-- (Column already existed from 0001; this just documents/enables the flow
-- -- no schema change needed beyond a sanity constraint.)
-- ============================================================
alter table decision_rationales add constraint provisional_needs_condition
  check (status <> 'provisional' or revisit_condition is not null);

-- ============================================================
-- review_gates: decided_at must be set whenever status leaves 'pending'.
-- ============================================================
alter table review_gates add constraint decided_requires_timestamp
  check (status = 'pending' or decided_at is not null);

-- ============================================================
-- RLS grants for the new view
-- ============================================================
grant select on unevaluated_artifacts to authenticated;
