-- QA workshop: ATAM/SAAM without chatbot scores.
-- In-boundary scenarios must be walked before HLD approval.
-- Model-assigned risk_level does not trigger the spike gate; only architect-set risk does.

alter table architectural_drivers
  add column if not exists response_measure text,
  add column if not exists tactic text,
  add column if not exists tactic_element text;

alter table decision_rationales
  add column if not exists risk_set_by text not null default 'model'
    check (risk_set_by in ('model', 'human'));

create or replace function keelrace_mark_risk_human() returns trigger as $$
begin
  if TG_OP = 'UPDATE' and NEW.risk_level is distinct from OLD.risk_level then
    NEW.risk_set_by := 'human';
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_risk_set_by_human on decision_rationales;
create trigger trg_risk_set_by_human
  before update on decision_rationales
  for each row execute function keelrace_mark_risk_human();

create table if not exists evaluation_utility_nodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  parent_id uuid references evaluation_utility_nodes(id) on delete cascade,
  quality text not null,
  attribute text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists evaluation_scenarios (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  driver_id uuid references architectural_drivers(id) on delete set null,
  utility_node_id uuid references evaluation_utility_nodes(id) on delete set null,
  title text not null,
  stimulus text,
  environment text,
  expected_response text,
  kind text not null default 'use' check (kind in ('use', 'growth', 'exploratory')),
  in_boundary boolean not null default false,
  grounding jsonb not null default '[]'::jsonb,
  confidence text not null default 'partial' check (confidence in ('grounded', 'partial', 'ungrounded')),
  created_at timestamptz not null default now()
);

create table if not exists evaluation_walks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  scenario_id uuid not null references evaluation_scenarios(id) on delete cascade,
  candidate_id uuid references architecture_candidates(id) on delete cascade,
  hld_document_id uuid references design_documents(id) on delete cascade,
  affected_components jsonb not null default '[]'::jsonb,
  path_summary text,
  confidence text not null default 'partial',
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  check (candidate_id is not null or hld_document_id is not null)
);

create unique index if not exists evaluation_walks_hld_uniq
  on evaluation_walks (scenario_id, hld_document_id) where hld_document_id is not null;
create unique index if not exists evaluation_walks_cand_uniq
  on evaluation_walks (scenario_id, candidate_id) where candidate_id is not null;

create table if not exists evaluation_outcomes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  scenario_id uuid not null references evaluation_scenarios(id) on delete cascade,
  candidate_id uuid not null references architecture_candidates(id) on delete cascade,
  qualitative_result text not null check (qualitative_result in ('holds', 'degrades', 'unknown')),
  rationale text,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (scenario_id, candidate_id)
);

create table if not exists evaluation_points (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('sensitivity', 'tradeoff')),
  quality_a text not null,
  quality_b text,
  element_name text,
  body text not null,
  scenario_id uuid references evaluation_scenarios(id) on delete set null,
  candidate_id uuid references architecture_candidates(id) on delete set null,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table evaluation_utility_nodes enable row level security;
alter table evaluation_scenarios enable row level security;
alter table evaluation_walks enable row level security;
alter table evaluation_outcomes enable row level security;
alter table evaluation_points enable row level security;

create policy evaluation_utility_nodes_rw on evaluation_utility_nodes for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy evaluation_scenarios_rw on evaluation_scenarios for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy evaluation_walks_rw on evaluation_walks for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy evaluation_outcomes_rw on evaluation_outcomes for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy evaluation_points_rw on evaluation_points for all using (is_project_member(project_id)) with check (is_project_member(project_id));

create or replace function approve_design_document(p_document_id uuid, p_reviewer_id uuid)
returns design_documents as $$
declare
  v_doc design_documents;
  v_project_id uuid;
  v_gate_status review_gate_status;
  v_uncited_nfrs int;
  v_unspiked_high_risk int;
  v_unresolved_conflicts int;
  v_unwalked int;
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

  select status into v_gate_status
    from review_gates
    where target_artifact_id = p_document_id and target_artifact_table = 'design_documents'
    order by created_at desc limit 1;
  if v_gate_status is distinct from 'approved' then
    raise exception 'cannot approve design_document %: review gate status is %, not approved', p_document_id, coalesce(v_gate_status::text, 'missing');
  end if;

  v_reconciliation_target_hld := case when v_doc.type = 'HLD' then v_doc.id else v_doc.hld_component_id end;
  if v_reconciliation_target_hld is not null then
    select count(*) into v_unconfirmed_reconciliation
      from component_reconciliations
      where hld_document_id = v_reconciliation_target_hld and not confirmed and array_length(vanished_family_keys, 1) > 0;
    if v_unconfirmed_reconciliation > 0 then
      raise exception 'cannot approve design_document %: unconfirmed component reconciliation on its HLD', p_document_id;
    end if;
  end if;

  if v_doc.type = 'HLD' then
    select array_agg(id) into v_in_scope_component_ids from components where hld_document_id = p_document_id;
  else
    v_in_scope_component_ids := array[v_doc.component_id];
  end if;

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

  -- Spike gate: only architect-confirmed high risk, never a model guess.
  select count(*) into v_unspiked_high_risk
    from decision_rationales dr
    where dr.design_document_id = p_document_id
      and dr.risk_level = 'high'
      and dr.risk_set_by = 'human'
      and not exists (select 1 from spike_records sr where sr.decision_rationale_id = dr.id and sr.completed);
  if v_unspiked_high_risk > 0 then
    raise exception 'cannot approve design_document %: % architect-rated high-risk decision(s) lack a completed spike', p_document_id, v_unspiked_high_risk;
  end if;

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

  -- In-boundary scenarios must have a walk on this HLD or the selected candidate.
  if v_doc.type = 'HLD' then
    select count(*) into v_unwalked
      from evaluation_scenarios s
      where s.project_id = v_project_id
        and s.in_boundary
        and not exists (
          select 1 from evaluation_walks w
          where w.scenario_id = s.id
            and w.status <> 'dismissed'
            and (
              w.hld_document_id = p_document_id
              or w.candidate_id in (
                select id from architecture_candidates
                where project_id = v_project_id and status = 'selected'
              )
            )
        );
    if v_unwalked > 0 then
      raise exception 'cannot approve design_document %: % in-boundary scenario(s) have no walk through the HLD or selected candidate. Mark them out of the workshop or walk them first. This is not a quality score.', p_document_id, v_unwalked;
    end if;
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

grant execute on function approve_design_document(uuid, uuid) to authenticated;

create index if not exists evaluation_scenarios_project on evaluation_scenarios (project_id, in_boundary);
create index if not exists evaluation_walks_project on evaluation_walks (project_id);
create index if not exists evaluation_outcomes_project on evaluation_outcomes (project_id);
create index if not exists evaluation_points_project on evaluation_points (project_id);

insert into architecture_knowledge (framework, category, title, body)
select 'ATAM', 'evaluation', 'Sensitivity and trade-off points',
 'A sensitivity point is an architectural decision that strongly affects one quality attribute. A trade-off point affects two or more attributes in opposite directions. Record them as findings. Do not convert them into a numeric grade or an automatic pass.'
where not exists (select 1 from architecture_knowledge where title = 'Sensitivity and trade-off points');
