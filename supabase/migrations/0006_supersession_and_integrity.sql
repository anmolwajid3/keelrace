-- KeelRace: Migration 0006
--   * Fixes a regression from 0004/generate-design-docs: superseding the
--     prior approved HLD/LLD at GENERATION time (before the replacement is
--     even reviewed) left a window with zero currently-approved documents.
--     Supersession for plain regeneration now happens at APPROVAL time,
--     inside approve_design_document() -- matching FR-10.5's actual model
--     ("once approved... the prior version becomes superseded"). The
--     change-request flow's supersession-on-resolve (resolve-change) is
--     untouched -- FR-10.5 genuinely does want that one to fire on
--     resolution, not on the new version's own later approval.
--   * components becomes identity-immutable (name/hld_document_id/project_id)
--     -- everything downstream (code artifacts, team boundaries,
--     deprecation, LLD-supersession name-matching) keys off these and could
--     previously be silently rewritten by any project member.
--   * drift_events.resolved_by/resolved_at are now auto-stamped, closing a
--     gap where the UI only ever set `resolution` and left them null forever.
--   * debt_items gets an append-only status history log, the same pattern
--     already used for review_gates -> review_actions.

-- ============================================================
-- Supersession moves to approval time
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
  v_component_name text;
  v_sibling_set_ids uuid[];
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

  -- Supersede the prior approved sibling(s), NOW that this version has
  -- actually cleared review -- not back at generation time, which left a
  -- window with no currently-approved document at all.
  select array_agg(id) into v_sibling_set_ids from requirement_sets where project_id = v_project_id;

  if v_doc.type = 'HLD' then
    update design_documents
      set status = 'superseded', superseded_by = v_doc.id
      where requirement_set_id = any(v_sibling_set_ids)
        and type = 'HLD'
        and status = 'approved'
        and id <> v_doc.id;
  else
    -- LLD: only supersede the prior approved LLD for the SAME component,
    -- matched by name (components are recreated fresh each generation, so
    -- there's no stable id to match on -- see README's noted limitation).
    select c.name into v_component_name from components c where c.id = v_doc.component_id;
    if v_component_name is not null then
      update design_documents dd
        set status = 'superseded', superseded_by = v_doc.id
        where dd.requirement_set_id = any(v_sibling_set_ids)
          and dd.type = 'LLD'
          and dd.status = 'approved'
          and dd.id <> v_doc.id
          and exists (select 1 from components c2 where c2.id = dd.component_id and c2.name = v_component_name);
    end if;
  end if;

  return v_doc;
end;
$$ language plpgsql security definer;

-- ============================================================
-- components: lock the identity fields the rest of the system keys off of
-- ============================================================
create or replace function guard_component_identity() returns trigger as $$
begin
  if NEW.name is distinct from OLD.name
     or NEW.hld_document_id is distinct from OLD.hld_document_id
     or NEW.project_id is distinct from OLD.project_id then
    raise exception 'components.name/hld_document_id/project_id are immutable after insert -- downstream links (code artifacts, team boundaries, deprecation, LLD supersession) key off them by name/id';
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_guard_component_identity
  before update on components
  for each row execute function guard_component_identity();

-- Prevent two components in the same HLD from sharing a name -- the exact
-- ambiguity that would silently confuse skeleton-file linking and
-- LLD-supersession matching, both of which match by name.
alter table components add constraint unique_component_name_per_hld unique (hld_document_id, name);

-- ============================================================
-- drift_events: auto-stamp resolved_by/resolved_at, don't rely on the
-- client to set them (the UI never did).
-- ============================================================
create or replace function stamp_drift_resolution() returns trigger as $$
begin
  if NEW.resolution is not null and OLD.resolution is distinct from NEW.resolution then
    NEW.resolved_by = auth.uid();
    NEW.resolved_at = now();
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_stamp_drift_resolution
  before update on drift_events
  for each row execute function stamp_drift_resolution();

-- ============================================================
-- debt_items: append-only status history, same pattern as
-- review_gates -> review_actions. Current row stays mutable (it's
-- operational state, not a decision record), but every transition is kept.
-- ============================================================
create table debt_item_status_log (
  id uuid primary key default gen_random_uuid(),
  debt_item_id uuid not null references debt_items(id) on delete cascade,
  old_status debt_status,
  new_status debt_status not null,
  changed_by uuid references profiles(id),
  changed_at timestamptz not null default now()
);
alter table debt_item_status_log enable row level security;
create policy debt_item_status_log_select on debt_item_status_log for select using (
  exists (select 1 from debt_items di where di.id = debt_item_id and is_project_member(di.project_id))
);
-- insert-only via trigger below; no direct insert policy needed for clients

create or replace function log_debt_status_change() returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    insert into debt_item_status_log (debt_item_id, old_status, new_status, changed_by)
    values (NEW.id, null, NEW.status, auth.uid());
  elsif NEW.status is distinct from OLD.status then
    insert into debt_item_status_log (debt_item_id, old_status, new_status, changed_by)
    values (NEW.id, OLD.status, NEW.status, auth.uid());
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_log_debt_status_change_insert
  after insert on debt_items
  for each row execute function log_debt_status_change();

create trigger trg_log_debt_status_change_update
  after update on debt_items
  for each row execute function log_debt_status_change();
