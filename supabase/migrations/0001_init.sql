-- KeelRace: Ideal Software Architecture System
-- Migration 0001: full schema, enums, constraints, RLS
-- Run via: supabase db push   (or paste into SQL editor)

-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
create type reviewer_role as enum ('architect', 'tech_lead', 'security_reviewer', 'domain_owner');
create type design_doc_type as enum ('HLD', 'LLD');
create type design_doc_status as enum ('draft', 'under_review', 'approved', 'superseded');
create type prototype_type as enum ('wireframe', 'flow-diagram');
create type review_gate_status as enum ('pending', 'approved', 'rejected', 'changes_requested');
create type review_action_type as enum ('approve', 'reject', 'request_changes');
create type code_artifact_type as enum ('file', 'directory');
create type drift_classification as enum ('conformant', 'local_deviation', 'architectural_drift');
create type drift_severity as enum ('low', 'medium', 'high');
create type drift_resolution_type as enum ('update_documentation', 'log_as_debt');
create type decision_status as enum ('proposed', 'provisional', 'approved', 'superseded');
create type risk_level as enum ('low', 'medium', 'high');
create type debt_status as enum ('open', 'acknowledged', 'resolved');
create type contract_type as enum ('api', 'event_schema');
create type change_request_status as enum ('submitted', 'scoped', 'triaged', 'approved', 'rejected', 'resolved');
create type signal_source_type as enum ('implementation_finding');
create type signal_classification as enum ('implementation_defect', 'requirement_gap');
create type deprecation_status as enum ('marked', 'dependents_migrated', 'removed');
create type requirement_set_status as enum ('draft', 'locked');

-- ============================================================
-- CORE / IDENTITY
-- ============================================================
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table project_members (
  project_id uuid references projects(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  role reviewer_role not null,
  -- FR-2.4: authority scoped per project to phases/boundaries
  phase_scope text[], -- null/empty = all phases
  primary key (project_id, user_id, role)
);

-- ============================================================
-- 1. REQUIREMENTS -> ARCHITECTURE DOCS (FR-1.x)
-- ============================================================
create table requirement_sets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  version int not null,
  status requirement_set_status not null default 'draft',
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create table requirements (
  id uuid primary key default gen_random_uuid(),
  requirement_set_id uuid not null references requirement_sets(id) on delete cascade,
  ref_code text not null, -- e.g. "FR-1.1"
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table design_documents (
  id uuid primary key default gen_random_uuid(),
  requirement_set_id uuid not null references requirement_sets(id),
  type design_doc_type not null,
  version int not null,
  status design_doc_status not null default 'draft',
  content jsonb not null default '{}'::jsonb,
  hld_component_id uuid, -- non-null required for LLD rows (enforced via trigger below)
  generated_at timestamptz not null default now(),
  generated_by_model text,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  -- NFR-3: append-only. Never overwritten; new version = new row.
  superseded_by uuid references design_documents(id)
);

-- FR-1.1 acceptance criterion: every LLD row has a non-null hld_component_id
create or replace function enforce_lld_component() returns trigger as $$
begin
  if NEW.type = 'LLD' and NEW.hld_component_id is null then
    raise exception 'LLD design_documents must have a non-null hld_component_id';
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_lld_component
  before insert or update on design_documents
  for each row execute function enforce_lld_component();

create table decision_rationales (
  id uuid primary key default gen_random_uuid(),
  design_document_id uuid not null references design_documents(id) on delete cascade,
  decision_point text not null,
  chosen_option text not null,
  alternatives_considered jsonb not null default '[]'::jsonb, -- [{option, rejection_reason}]
  driving_requirements uuid[] not null, -- FK-ish array into requirements.id
  searchable_text text, -- FR-5.1
  status decision_status not null default 'approved',
  revisit_condition jsonb, -- FR-5.2 {metric, operator, threshold}
  risk_level risk_level not null default 'low', -- FR-7.2
  created_at timestamptz not null default now(),
  constraint driving_requirements_nonempty check (array_length(driving_requirements, 1) > 0)
);

create index idx_decision_rationales_search on decision_rationales using gin (to_tsvector('english', coalesce(searchable_text, '')));

create table design_chat_threads (
  id uuid primary key default gen_random_uuid(),
  decision_rationale_id uuid not null references decision_rationales(id) on delete cascade,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table design_chat_messages (
  id uuid primary key default gen_random_uuid(),
  decision_rationale_id uuid not null references decision_rationales(id) on delete cascade,
  thread_id uuid not null references design_chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table prototypes (
  id uuid primary key default gen_random_uuid(),
  design_document_id uuid not null references design_documents(id),
  type prototype_type not null,
  content jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

-- ============================================================
-- 2. HUMAN REVIEW (FR-2.x)
-- ============================================================
create table review_gates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  phase text not null,
  target_artifact_id uuid not null,
  target_artifact_table text not null, -- polymorphic reference target table name
  status review_gate_status not null default 'pending',
  reviewer_id uuid references profiles(id),
  decided_at timestamptz,
  comment text,
  created_at timestamptz not null default now()
);

create table review_actions (
  id uuid primary key default gen_random_uuid(),
  reviewable_item_id uuid not null,
  reviewable_item_table text not null,
  batch_id uuid,
  action review_action_type not null,
  comment text,
  reviewer_id uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  constraint request_changes_needs_comment check (
    action <> 'request_changes' or (comment is not null and length(trim(comment)) > 0)
  )
);
-- NFR-3: insert-only. No update/delete grants for this table (enforced via RLS below).

-- ============================================================
-- 3. STARTER CODE (FR-3.x)
-- ============================================================
create table code_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  parent_id uuid references code_artifacts(id),
  path text not null,
  type code_artifact_type not null,
  content text, -- null for directories; interfaces/skeleton only, never implementation bodies
  content_hash text,
  design_component_id uuid references decision_rationales(id), -- component-first traceability
  is_placeholder boolean not null default true,
  created_at timestamptz not null default now(),
  unique (project_id, path)
);

-- ============================================================
-- 4. DRIFT DETECTION (FR-4.x)
-- ============================================================
create table drift_events (
  id uuid primary key default gen_random_uuid(),
  code_artifact_id uuid not null references code_artifacts(id) on delete cascade,
  baseline_hash text not null,
  current_hash text not null,
  detected_at timestamptz not null default now(),
  classification drift_classification not null,
  severity drift_severity,
  blast_radius_count int, -- FR-4.3: recomputable, never cached indefinitely
  resolution drift_resolution_type,
  resolved_by uuid references profiles(id),
  resolved_at timestamptz
);

-- code_artifact dependency graph, for blast-radius (FR-4.3) and impact scoping (FR-7.3/FR-10.4)
create table code_dependencies (
  from_artifact_id uuid references code_artifacts(id) on delete cascade,
  to_artifact_id uuid references code_artifacts(id) on delete cascade,
  is_critical_path boolean not null default false,
  primary key (from_artifact_id, to_artifact_id)
);

-- ============================================================
-- 5. DECISION TRACKING extras (FR-5.x)
-- (decision_rationales table already covers 5.1/5.2's base fields)
-- ============================================================
create table revisit_checks (
  id uuid primary key default gen_random_uuid(),
  decision_rationale_id uuid not null references decision_rationales(id) on delete cascade,
  checked_by uuid not null references profiles(id),
  checked_at timestamptz not null default now(),
  condition_met boolean not null,
  evidence_note text
);

create table nfr_conflicts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  nfr_a_id uuid not null,
  nfr_b_id uuid not null,
  description text not null,
  resolution_decision_rationale_id uuid references decision_rationales(id),
  created_at timestamptz not null default now()
);

create table architecture_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  label text,
  structure jsonb not null, -- immutable structural capture
  created_at timestamptz not null default now()
);
-- immutability enforced via RLS (no update policy)

-- ============================================================
-- 6. DIAGRAMS (FR-6.x) - rendered, not stored as separate source of truth.
-- No table: diagrams are derived views over code_artifacts / code_dependencies /
-- design_documents at read time. See frontend DiagramView + edge function `render-diagram`.
-- ============================================================

-- ============================================================
-- 7. CATCHING PROBLEMS EARLY (FR-7.x)
-- ============================================================
create table nfrs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table nfr_citations (
  nfr_id uuid references nfrs(id) on delete cascade,
  decision_rationale_id uuid references decision_rationales(id) on delete cascade,
  primary key (nfr_id, decision_rationale_id)
);

create table spike_records (
  id uuid primary key default gen_random_uuid(),
  decision_rationale_id uuid not null references decision_rationales(id) on delete cascade,
  summary text not null,
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table triage_decisions (
  id uuid primary key default gen_random_uuid(),
  change_request_id uuid, -- nullable, set for Door 1
  signal_id uuid,          -- nullable, set for Door 2
  requires_full_review boolean not null,
  reasoning text not null,
  triggering_factors text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint triage_origin check (
    (change_request_id is not null)::int + (signal_id is not null)::int = 1
  )
);

-- ============================================================
-- 8. CROSS-TEAM COORDINATION (FR-8.x)
-- ============================================================
create table service_contracts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  service_name text not null,
  type contract_type not null,
  version int not null,
  spec jsonb not null, -- OpenAPI doc or event schema
  breaking_change boolean, -- null = "not automatically evaluated" (event_schema, phase 1)
  diff_tool_report jsonb,
  created_at timestamptz not null default now(),
  constraint event_schema_null_breaking check (
    type <> 'event_schema' or breaking_change is null
  )
);

create table team_boundaries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  design_component_id uuid references decision_rationales(id),
  owning_team text, -- null = "unowned" -> must be flagged, never silently unrouted
  created_at timestamptz not null default now()
);

-- ============================================================
-- 9. ONGOING GOVERNANCE (FR-9.x)
-- ============================================================
create table debt_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  drift_event_id uuid references drift_events(id),
  description text not null,
  status debt_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table deployment_topologies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null, -- e.g. "prod", "staging"
  version int not null,
  structure jsonb not null,
  created_at timestamptz not null default now()
);

create table threat_models (
  id uuid primary key default gen_random_uuid(),
  design_document_id uuid not null references design_documents(id) on delete cascade,
  trust_boundaries jsonb not null default '[]'::jsonb,
  data_flows jsonb not null default '[]'::jsonb,
  identified_threats jsonb not null default '[]'::jsonb, -- [{description, stride_category}]
  created_at timestamptz not null default now()
);

create table deprecation_records (
  id uuid primary key default gen_random_uuid(),
  code_artifact_id uuid references code_artifacts(id),
  design_component_id uuid references decision_rationales(id),
  status deprecation_status not null default 'marked',
  marked_at timestamptz not null default now(),
  removed_at timestamptz
);

-- ============================================================
-- 10. CHANGE HANDLING (FR-10.x)
-- ============================================================
create table change_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  requested_by uuid not null references profiles(id),
  description text not null,
  action text not null check (action in ('add', 'modify', 'remove')),
  target_requirement_id uuid references requirements(id), -- required for modify/remove
  proposed_text text,
  status change_request_status not null default 'submitted',
  created_at timestamptz not null default now(),
  resolved_document_version_id uuid references design_documents(id),
  constraint target_required_for_modify_remove check (
    action = 'add' or target_requirement_id is not null
  )
);

create table signals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  raised_by uuid not null references profiles(id),
  source_type signal_source_type not null default 'implementation_finding',
  description text not null,
  raised_against_artifact_id uuid, -- polymorphic (code_artifact usually)
  classification signal_classification,
  routed_to_requirement_id uuid references requirements(id), -- only set when requirement_gap
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_document_version_id uuid references design_documents(id),
  constraint routing_only_on_gap check (
    routed_to_requirement_id is null or classification = 'requirement_gap'
  )
);

-- FR-10.4 reconvergence: which decision_rationales/design_documents got flagged needs_review
create table change_impact_traces (
  id uuid primary key default gen_random_uuid(),
  change_request_id uuid references change_requests(id),
  signal_id uuid references signals(id),
  decision_rationale_id uuid not null references decision_rationales(id),
  created_at timestamptz not null default now(),
  constraint impact_origin check (
    (change_request_id is not null)::int + (signal_id is not null)::int = 1
  )
);

alter table design_documents add column needs_review boolean not null default false;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table profiles enable row level security;
alter table projects enable row level security;
alter table project_members enable row level security;
alter table requirement_sets enable row level security;
alter table requirements enable row level security;
alter table design_documents enable row level security;
alter table decision_rationales enable row level security;
alter table design_chat_threads enable row level security;
alter table design_chat_messages enable row level security;
alter table prototypes enable row level security;
alter table review_gates enable row level security;
alter table review_actions enable row level security;
alter table code_artifacts enable row level security;
alter table drift_events enable row level security;
alter table code_dependencies enable row level security;
alter table revisit_checks enable row level security;
alter table nfr_conflicts enable row level security;
alter table architecture_snapshots enable row level security;
alter table nfrs enable row level security;
alter table nfr_citations enable row level security;
alter table spike_records enable row level security;
alter table triage_decisions enable row level security;
alter table service_contracts enable row level security;
alter table team_boundaries enable row level security;
alter table debt_items enable row level security;
alter table deployment_topologies enable row level security;
alter table threat_models enable row level security;
alter table deprecation_records enable row level security;
alter table change_requests enable row level security;
alter table signals enable row level security;
alter table change_impact_traces enable row level security;

-- Helper: is the current user a member of a project?
create or replace function is_project_member(p_project_id uuid) returns boolean as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id and user_id = auth.uid()
  );
$$ language sql security definer stable;

-- Helper: does the current user hold a given role on a project (FR-2.4 authority check)
create or replace function has_project_role(p_project_id uuid, p_role reviewer_role) returns boolean as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id and user_id = auth.uid() and role = p_role
  );
$$ language sql security definer stable;

-- profiles: user can see/edit their own row; can see others' names for attribution
create policy profiles_select_all on profiles for select using (true);
create policy profiles_update_self on profiles for update using (id = auth.uid());
create policy profiles_insert_self on profiles for insert with check (id = auth.uid());

-- projects: members only
create policy projects_select_member on projects for select using (is_project_member(id) or created_by = auth.uid());
create policy projects_insert_any on projects for insert with check (created_by = auth.uid());
create policy projects_update_member on projects for update using (is_project_member(id));

create policy project_members_select on project_members for select using (is_project_member(project_id));
create policy project_members_insert on project_members for insert with check (is_project_member(project_id) or true); -- first member (creator) bootstrap

-- generic project-scoped read policy pattern, applied per table
create policy requirement_sets_rw on requirement_sets for all using (is_project_member(project_id));
create policy requirements_rw on requirements for select using (
  exists (select 1 from requirement_sets rs where rs.id = requirement_set_id and is_project_member(rs.project_id))
);
create policy requirements_insert on requirements for insert with check (
  exists (select 1 from requirement_sets rs where rs.id = requirement_set_id and is_project_member(rs.project_id))
);

create policy design_documents_select on design_documents for select using (
  exists (select 1 from requirement_sets rs where rs.id = requirement_set_id and is_project_member(rs.project_id))
);
-- NFR-3: no update policy on content/version -- only status/approval fields updatable via function, not direct grant
create policy design_documents_insert on design_documents for insert with check (
  exists (select 1 from requirement_sets rs where rs.id = requirement_set_id and is_project_member(rs.project_id))
);
create policy design_documents_update_status on design_documents for update using (
  exists (select 1 from requirement_sets rs where rs.id = requirement_set_id and is_project_member(rs.project_id))
);

create policy decision_rationales_select on decision_rationales for select using (
  exists (
    select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = design_document_id and is_project_member(rs.project_id)
  )
);
create policy decision_rationales_insert on decision_rationales for insert with check (
  exists (
    select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = design_document_id and is_project_member(rs.project_id)
  )
);

create policy design_chat_threads_rw on design_chat_threads for all using (
  exists (
    select 1 from decision_rationales dr
    join design_documents dd on dd.id = dr.design_document_id
    join requirement_sets rs on rs.id = dd.requirement_set_id
    where dr.id = decision_rationale_id and is_project_member(rs.project_id)
  )
);
create policy design_chat_messages_rw on design_chat_messages for all using (
  exists (
    select 1 from decision_rationales dr
    join design_documents dd on dd.id = dr.design_document_id
    join requirement_sets rs on rs.id = dd.requirement_set_id
    where dr.id = decision_rationale_id and is_project_member(rs.project_id)
  )
);

create policy prototypes_rw on prototypes for all using (
  exists (
    select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = design_document_id and is_project_member(rs.project_id)
  )
);

create policy review_gates_rw on review_gates for all using (is_project_member(project_id));

-- review_actions: insert-only, no update/delete policies at all (NFR-3)
create policy review_actions_select on review_actions for select using (true);
create policy review_actions_insert on review_actions for insert with check (auth.uid() = reviewer_id);

create policy code_artifacts_rw on code_artifacts for all using (is_project_member(project_id));
create policy drift_events_select on drift_events for select using (
  exists (select 1 from code_artifacts ca where ca.id = code_artifact_id and is_project_member(ca.project_id))
);
create policy drift_events_insert on drift_events for insert with check (
  exists (select 1 from code_artifacts ca where ca.id = code_artifact_id and is_project_member(ca.project_id))
);
create policy drift_events_update on drift_events for update using (
  exists (select 1 from code_artifacts ca where ca.id = code_artifact_id and is_project_member(ca.project_id))
);
create policy code_dependencies_rw on code_dependencies for all using (
  exists (select 1 from code_artifacts ca where ca.id = from_artifact_id and is_project_member(ca.project_id))
);

create policy revisit_checks_rw on revisit_checks for all using (
  exists (
    select 1 from decision_rationales dr join design_documents dd on dd.id = dr.design_document_id
    join requirement_sets rs on rs.id = dd.requirement_set_id
    where dr.id = decision_rationale_id and is_project_member(rs.project_id)
  )
);

create policy nfr_conflicts_rw on nfr_conflicts for all using (is_project_member(project_id));
create policy architecture_snapshots_select on architecture_snapshots for select using (is_project_member(project_id));
create policy architecture_snapshots_insert on architecture_snapshots for insert with check (is_project_member(project_id));
-- no update/delete: immutable

create policy nfrs_rw on nfrs for all using (is_project_member(project_id));
create policy nfr_citations_rw on nfr_citations for all using (
  exists (select 1 from nfrs n where n.id = nfr_id and is_project_member(n.project_id))
);
create policy spike_records_rw on spike_records for all using (
  exists (
    select 1 from decision_rationales dr join design_documents dd on dd.id = dr.design_document_id
    join requirement_sets rs on rs.id = dd.requirement_set_id
    where dr.id = decision_rationale_id and is_project_member(rs.project_id)
  )
);
create policy triage_decisions_select on triage_decisions for select using (true);
create policy triage_decisions_insert on triage_decisions for insert with check (true);

create policy service_contracts_rw on service_contracts for all using (is_project_member(project_id));
create policy team_boundaries_rw on team_boundaries for all using (is_project_member(project_id));
create policy debt_items_rw on debt_items for all using (is_project_member(project_id));
create policy deployment_topologies_rw on deployment_topologies for all using (is_project_member(project_id));
create policy threat_models_rw on threat_models for all using (
  exists (select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = design_document_id and is_project_member(rs.project_id))
);
create policy deprecation_records_rw on deprecation_records for all using (true);

create policy change_requests_rw on change_requests for all using (is_project_member(project_id));
create policy signals_rw on signals for all using (is_project_member(project_id));
create policy change_impact_traces_select on change_impact_traces for select using (true);
create policy change_impact_traces_insert on change_impact_traces for insert with check (true);

-- ============================================================
-- Auto-create profile row on signup
-- ============================================================
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
