-- KeelRace: Migration 0010
--   * The reconciliation gate added in 0008 only blocked HLD approval.
--     An LLD could still be approved while its parent HLD had an
--     unconfirmed component reconciliation pending. Extends the same
--     check to LLDs, via their parent HLD (hld_component_id).

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
  v_reconciliation_target_hld uuid;
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
  -- reconciliation can't be approved until a human has confirmed it --
  -- and neither can any of ITS LLDs, via the parent HLD (hld_component_id).
  v_reconciliation_target_hld := case when v_doc.type = 'HLD' then v_doc.id else v_doc.hld_component_id end;
  if v_reconciliation_target_hld is not null then
    select count(*) into v_unconfirmed_reconciliation
      from component_reconciliations
      where hld_document_id = v_reconciliation_target_hld and not confirmed and array_length(vanished_family_keys, 1) > 0;
    if v_unconfirmed_reconciliation > 0 then
      raise exception 'cannot approve design_document %: unconfirmed component reconciliation on its HLD (components vanished vs. the prior version -- confirm intentional first)', p_document_id;
    end if;
  end if;

  -- Which components are actually in scope for this document (for HLD:
  -- every component it defines; for LLD: just its own).
  if v_doc.type = 'HLD' then
    select array_agg(id) into v_in_scope_component_ids from components where hld_document_id = p_document_id;
  else
    v_in_scope_component_ids := array[v_doc.component_id];
  end if;

  -- FR-7.1, per-component scoped
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
