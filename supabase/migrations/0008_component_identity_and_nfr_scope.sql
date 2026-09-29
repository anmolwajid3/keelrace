-- KeelRace: Migration 0008
--   * components get a stable identity (family_key) that survives
--     regeneration, separate from the display name -- matching the pattern
--     requirements.ref_code already uses across RequirementSet versions.
--     reference_code (family_key + creation timestamp) is the human-facing
--     citation form.
--   * Every regeneration that changes the component set produces a
--     component_reconciliations row the reviewer must confirm before the
--     new HLD can be approved -- catching a bad LLM match instead of
--     letting it silently break downstream links.
--   * NFRs can now be scoped to a specific component instead of always
--     applying project-wide, and approval's NFR-coverage check (FR-7.1)
--     only requires citation for NFRs actually in scope for that document.

-- ============================================================
-- Stable component identity
-- ============================================================
alter table components add column if not exists family_key text;
alter table components add column if not exists reference_code text;

-- reference_code = family_key + creation timestamp (e.g. "CMP0001-20260922143000").
-- This can't be a GENERATED column: to_char(timestamptz, text) depends on the
-- session's TimeZone setting, so Postgres won't accept it as IMMUTABLE. A
-- BEFORE INSERT/UPDATE trigger has no such restriction and gives the same
-- always-computed, never-drifts-from-family_key behavior.
create or replace function set_component_reference_code() returns trigger as $$
begin
  NEW.reference_code := NEW.family_key || '-' || to_char(NEW.created_at at time zone 'UTC', 'YYYYMMDDHH24MISS');
  return NEW;
end;
$$ language plpgsql;

create trigger trg_set_component_reference_code
  before insert or update of family_key on components
  for each row execute function set_component_reference_code();

-- Backfill: existing components (pre-migration) get their own id as their
-- family_key, i.e. they're treated as having no history to match against --
-- correct, since nothing before this migration tracked continuity anyway.
update components set family_key = 'CMP' || replace(id::text, '-', '') where family_key is null;
alter table components alter column family_key set not null;

alter table components add constraint unique_family_key_per_hld unique (hld_document_id, family_key);

-- family_key joins the identity fields the guard already protects.
create or replace function guard_component_identity() returns trigger as $$
begin
  if NEW.name is distinct from OLD.name
     or NEW.hld_document_id is distinct from OLD.hld_document_id
     or NEW.project_id is distinct from OLD.project_id
     or NEW.family_key is distinct from OLD.family_key then
    raise exception 'components.name/hld_document_id/project_id/family_key are immutable after insert -- downstream links (code artifacts, team boundaries, deprecation, LLD supersession, NFR scoping) key off them';
  end if;
  return NEW;
end;
$$ language plpgsql;
-- trigger already points at this function name via CREATE OR REPLACE; no re-create needed.

-- ============================================================
-- Reconciliation: human confirms component continuity/removal before the
-- resulting HLD can be approved.
-- ============================================================
create table component_reconciliations (
  id uuid primary key default gen_random_uuid(),
  hld_document_id uuid not null references design_documents(id) on delete cascade,
  vanished_family_keys text[] not null default '{}',  -- present in the prior HLD, absent from this one
  new_family_keys text[] not null default '{}',        -- present here, absent from the prior HLD
  confirmed boolean not null default false,
  confirmed_by uuid references profiles(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table component_reconciliations enable row level security;
create policy component_reconciliations_select on component_reconciliations for select using (
  exists (
    select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = hld_document_id and is_project_member(rs.project_id)
  )
);
create policy component_reconciliations_insert on component_reconciliations for insert with check (
  exists (
    select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = hld_document_id and is_project_member(rs.project_id)
  )
);
create policy component_reconciliations_confirm on component_reconciliations for update using (
  exists (
    select 1 from design_documents dd join requirement_sets rs on rs.id = dd.requirement_set_id
    where dd.id = hld_document_id and is_project_member(rs.project_id)
  )
);

-- ============================================================
-- Per-component NFR scoping (FR-7.1)
-- ============================================================
alter table nfrs add column if not exists component_id uuid references components(id);

-- ============================================================
-- approve_design_document(): scope the NFR-coverage check to what's
-- actually relevant to this document, and require reconciliation
-- confirmation for HLDs that have one pending.
-- ============================================================
create or replace function approve_design_document(p_document_id uuid, p_reviewer_id uuid)
returns design_documents as $$
declare
  v_doc design_documents;
  v_project_id uuid;
  v_gate_status review_gate_status;
  v_uncited_nfrs int;
  v_unspiked_high_risk int;
  v_unresolved_conflicts int;
  v_family_key text;
  v_sibling_set_ids uuid[];
  v_unconfirmed_reconciliation int;
  v_in_scope_component_ids uuid[];
begin
  select * into v_doc from design_documents where id = p_document_id for update;
  if v_doc is null then
    raise exception 'design_document % not found', p_document_id;
  end if;

  select rs.project_id into v_project_id from requirement_sets rs where rs.id = v_doc.requirement_set_id;

  -- FR-2.1: no approval without an approved gate targeting this exact document
  select status into v_gate_status
    from review_gates
    where target_artifact_id = p_document_id and target_artifact_table = 'design_documents'
    order by created_at desc limit 1;
  if v_gate_status is distinct from 'approved' then
    raise exception 'cannot approve design_document %: review gate status is %, not approved', p_document_id, coalesce(v_gate_status::text, 'missing');
  end if;

  -- Reconciliation gate: an HLD with a pending (unconfirmed) component
  -- reconciliation can't be approved until a human has confirmed it.
  if v_doc.type = 'HLD' then
    select count(*) into v_unconfirmed_reconciliation
      from component_reconciliations
      where hld_document_id = p_document_id and not confirmed and array_length(vanished_family_keys, 1) > 0;
    if v_unconfirmed_reconciliation > 0 then
      raise exception 'cannot approve design_document %: unconfirmed component reconciliation (components vanished vs. the prior HLD -- confirm intentional first)', p_document_id;
    end if;
  end if;

  -- Which components are actually in scope for this document (for HLD:
  -- every component it defines; for LLD: just its own).
  if v_doc.type = 'HLD' then
    select array_agg(id) into v_in_scope_component_ids from components where hld_document_id = p_document_id;
  else
    v_in_scope_component_ids := array[v_doc.component_id];
  end if;

  -- FR-7.1, per-component scoped: an NFR blocks approval only if it's
  -- either project-wide (component_id is null) or scoped to a component
  -- actually in this document, and isn't cited by any decision here.
  if not v_doc.nfr_override then
    select count(*) into v_uncited_nfrs
      from nfrs n
      where n.project_id = v_project_id
        and (n.component_id is null or n.component_id = any(coalesce(v_in_scope_component_ids, array[]::uuid[])))
        and not exists (
          select 1 from nfr_citations nc
          join decision_rationales dr on dr.id = nc.decision_rationale_id
          where nc.nfr_id = n.id and dr.design_document_id = p_document_id
        );
    if v_uncited_nfrs > 0 then
      raise exception 'cannot approve design_document %: % in-scope NFR(s) not addressed (set nfr_override to bypass)', p_document_id, v_uncited_nfrs;
    end if;
  end if;

  -- FR-7.2: no high-risk decision reaches approved without a completed spike
  select count(*) into v_unspiked_high_risk
    from decision_rationales dr
    where dr.design_document_id = p_document_id
      and dr.risk_level = 'high'
      and not exists (select 1 from spike_records sr where sr.decision_rationale_id = dr.id and sr.completed);
  if v_unspiked_high_risk > 0 then
    raise exception 'cannot approve design_document %: % high-risk decision(s) lack a completed spike', p_document_id, v_unspiked_high_risk;
  end if;

  -- FR-5.3: unresolved NFR conflicts touching this document's cited NFRs block approval
  select count(*) into v_unresolved_conflicts
    from nfr_conflicts nc
    where nc.project_id = v_project_id
      and nc.resolution_decision_rationale_id is null
      and (nc.nfr_a_id in (
            select nfr_id from nfr_citations nci join decision_rationales dr on dr.id = nci.decision_rationale_id
            where dr.design_document_id = p_document_id
          )
          or nc.nfr_b_id in (
            select nfr_id from nfr_citations nci join decision_rationales dr on dr.id = nci.decision_rationale_id
            where dr.design_document_id = p_document_id
          ));
  if v_unresolved_conflicts > 0 then
    raise exception 'cannot approve design_document %: % unresolved NFR conflict(s)', p_document_id, v_unresolved_conflicts;
  end if;

  perform set_config('keelrace.approving', 'true', true);
  update design_documents
    set status = 'approved', approved_by = p_reviewer_id, approved_at = now()
    where id = p_document_id
    returning * into v_doc;
  perform set_config('keelrace.approving', 'false', true);

  select array_agg(id) into v_sibling_set_ids from requirement_sets where project_id = v_project_id;

  if v_doc.type = 'HLD' then
    update design_documents
      set status = 'superseded', superseded_by = v_doc.id
      where requirement_set_id = any(v_sibling_set_ids)
        and type = 'HLD'
        and status = 'approved'
        and id <> v_doc.id;
  else
    select c.family_key into v_family_key from components c where c.id = v_doc.component_id;
    if v_family_key is not null then
      update design_documents dd
        set status = 'superseded', superseded_by = v_doc.id
        where dd.requirement_set_id = any(v_sibling_set_ids)
          and dd.type = 'LLD'
          and dd.status = 'approved'
          and dd.id <> v_doc.id
          and exists (select 1 from components c2 where c2.id = dd.component_id and c2.family_key = v_family_key);
    end if;
  end if;

  return v_doc;
end;
$$ language plpgsql security definer;