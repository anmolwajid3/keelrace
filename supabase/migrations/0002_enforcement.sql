-- KeelRace: Migration 0002 -- close enforcement gaps found in review
--   * Review gates become the actual approval mechanism (FR-2.1), not a
--     parallel, unconnected table
--   * Reviewer authority is checked, not assumed (FR-2.4)
--   * FR-7.1 (NFR coverage), FR-7.2 (risk/spike), FR-5.3 (NFR conflicts) now
--     block approval at the data layer instead of only in the UI
--   * NFR-2 becomes a real constraint, not app-level discipline
--   * FR-9.5 removal guard enforced
--   * FR-9.3 / FR-9.4 completeness columns for the Governance tab

-- ============================================================
-- NFR-2: no approved row with a null reviewer_id/decided_at
-- ============================================================
alter table design_documents
  add constraint approved_requires_reviewer
  check (status <> 'approved' or (approved_by is not null and approved_at is not null));

-- ============================================================
-- New columns supporting FR-7.1 override, FR-9.4 flagging
-- ============================================================
alter table design_documents add column if not exists nfr_override boolean not null default false;
alter table design_documents add column if not exists crosses_trust_boundary boolean not null default false;

-- ============================================================
-- FR-2.4: reviewer authority.
-- A reviewer may act on a review_gate/review_action for a project only if
-- they are a project_member whose phase_scope is null (all phases) or
-- contains the gate's phase.
-- ============================================================
create or replace function is_authorized_reviewer(p_project_id uuid, p_reviewer_id uuid, p_phase text)
returns boolean as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id
      and user_id = p_reviewer_id
      and (phase_scope is null or array_length(phase_scope, 1) is null or p_phase = any(phase_scope))
  );
$$ language sql security definer stable;

create or replace function enforce_review_gate_authority() returns trigger as $$
begin
  if NEW.status is distinct from OLD.status and NEW.status <> 'pending' then
    if NEW.reviewer_id is null or not is_authorized_reviewer(NEW.project_id, NEW.reviewer_id, NEW.phase) then
      raise exception 'reviewer % is not authorized for phase % on project %', NEW.reviewer_id, NEW.phase, NEW.project_id;
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_review_gate_authority
  before update on review_gates
  for each row execute function enforce_review_gate_authority();

create or replace function enforce_review_action_authority() returns trigger as $$
declare
  v_project_id uuid;
  v_phase text;
begin
  -- review_actions are polymorphic; resolve project_id via the gate they close out
  -- when reviewable_item_table = 'review_gates'. For other tables we only require
  -- that the reviewer is a member of *some* project touching the item; the stricter
  -- gate-level check above is the primary enforcement point for design_documents.
  if NEW.reviewable_item_table = 'review_gates' then
    select project_id, phase into v_project_id, v_phase from review_gates where id = NEW.reviewable_item_id;
    if v_project_id is not null and not is_authorized_reviewer(v_project_id, NEW.reviewer_id, v_phase) then
      raise exception 'reviewer % is not authorized for phase % on project %', NEW.reviewer_id, v_phase, v_project_id;
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_review_action_authority
  before insert on review_actions
  for each row execute function enforce_review_action_authority();

-- ============================================================
-- FR-2.1 + FR-7.1 + FR-7.2 + FR-5.3, unified:
-- approve_design_document() is now the ONLY path to approving a design
-- document. It requires an approved review_gate for that document, then
-- checks NFR coverage, risk/spike completion, and NFR conflicts before
-- writing approved/approved_by/approved_at. Raises a descriptive exception
-- on any failed check instead of silently accepting.
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

  -- FR-7.1: every project NFR must be cited by a decision_rationale of this document, unless overridden
  if not v_doc.nfr_override then
    select count(*) into v_uncited_nfrs
      from nfrs n
      where n.project_id = v_project_id
        and not exists (
          select 1 from nfr_citations nc
          join decision_rationales dr on dr.id = nc.decision_rationale_id
          where nc.nfr_id = n.id and dr.design_document_id = p_document_id
        );
    if v_uncited_nfrs > 0 then
      raise exception 'cannot approve design_document %: % NFR(s) not addressed (set nfr_override to bypass)', p_document_id, v_uncited_nfrs;
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

  return v_doc;
end;
$$ language plpgsql security definer;

-- Block direct client-side writes of status='approved' -- the RPC above
-- (via set_config) is the only door through which a document may become
-- approved, so a project member can no longer skip the gate/NFR/risk/
-- conflict checks just by issuing a plain UPDATE.
create or replace function guard_direct_approval() returns trigger as $$
begin
  if NEW.status = 'approved' and OLD.status is distinct from 'approved'
     and coalesce(current_setting('keelrace.approving', true), 'false') <> 'true' then
    raise exception 'design_documents.status may only be set to approved via approve_design_document()';
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_guard_direct_approval
  before update on design_documents
  for each row execute function guard_direct_approval();

-- Auto-create a pending review_gate whenever a design_document is generated,
-- so the queue always has something to review -- closes the "gates never get
-- created" gap.
create or replace function create_gate_for_design_document() returns trigger as $$
declare
  v_project_id uuid;
begin
  select rs.project_id into v_project_id from requirement_sets rs where rs.id = NEW.requirement_set_id;
  insert into review_gates (project_id, phase, target_artifact_id, target_artifact_table, status)
  values (v_project_id, NEW.type::text, NEW.id, 'design_documents', 'pending');
  return NEW;
end;
$$ language plpgsql;

create trigger trg_create_gate_for_design_document
  after insert on design_documents
  for each row execute function create_gate_for_design_document();

-- When a review_gate targeting a design_document is approved, call
-- approve_design_document() so all the checks above run as part of the
-- same decision -- the reviewer doesn't get to bypass them by approving
-- the gate and having nothing enforce the document side.
create or replace function sync_gate_approval_to_document() returns trigger as $$
begin
  if NEW.status = 'approved' and OLD.status is distinct from 'approved' and NEW.target_artifact_table = 'design_documents' then
    perform approve_design_document(NEW.target_artifact_id, NEW.reviewer_id);
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_sync_gate_approval
  after update on review_gates
  for each row execute function sync_gate_approval_to_document();

-- ============================================================
-- FR-9.5: cannot reach 'removed' while any snapshotted dependent is active
-- and unmigrated. "Active" = has an inbound code_dependencies edge from an
-- artifact that is not itself removed.
-- ============================================================
create or replace function enforce_deprecation_removal() returns trigger as $$
declare
  v_active_dependents int;
begin
  if NEW.status = 'removed' and OLD.status is distinct from 'removed' and NEW.code_artifact_id is not null then
    select count(*) into v_active_dependents
      from code_dependencies cd
      where cd.to_artifact_id = NEW.code_artifact_id
        and not exists (
          select 1 from deprecation_records dr2
          where dr2.code_artifact_id = cd.from_artifact_id and dr2.status = 'removed'
        );
    if v_active_dependents > 0 then
      raise exception 'cannot mark deprecation_record %: % dependent(s) still active/unmigrated', NEW.id, v_active_dependents;
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_deprecation_removal
  before update on deprecation_records
  for each row execute function enforce_deprecation_removal();

-- ============================================================
-- RLS: grant execute on the new RPC to authenticated users (RLS on the
-- underlying tables still applies inside the function's own checks via
-- security definer + the manual project_id/gate lookups above).
-- ============================================================
grant execute on function approve_design_document(uuid, uuid) to authenticated;
grant execute on function is_authorized_reviewer(uuid, uuid, text) to authenticated;
