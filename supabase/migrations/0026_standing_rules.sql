-- Standing rules and soft authority.
-- An approved decision can carry a rule later changes must hold, break, or replace.
-- classify_option mirrors supabase/functions/_shared/rule-check.mjs.
-- "replaces" is only written by replace_standing_rule, which requires another decision.

alter table projects
  add column if not exists study_mode boolean not null default false,
  add column if not exists precommitment text,
  add column if not exists precommitment_used boolean not null default false;

alter table change_requests
  add column if not exists claimed_ending text,
  add column if not exists covers jsonb not null default '{}'::jsonb;

alter table signals
  add column if not exists claimed_ending text;

alter table architecture_candidates
  add column if not exists generation_index int,
  add column if not exists generation_batch uuid,
  add column if not exists constraint_verdict text not null default 'clear',
  add column if not exists constraint_reason text;

alter table architecture_candidates drop constraint if exists architecture_candidates_constraint_verdict_check;
alter table architecture_candidates
  add constraint architecture_candidates_constraint_verdict_check
  check (constraint_verdict in ('clear', 'breaks'));

alter table assist_adr_drafts
  add column if not exists rule_text text,
  add column if not exists ends_when text,
  add column if not exists cover_labels text[] not null default '{}';

create table if not exists standing_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  decision_rationale_id uuid not null unique references decision_rationales(id) on delete cascade,
  rule_text text not null,
  ends_when text not null,
  allowed_endings text[] not null default '{}',
  covers jsonb not null default '{}'::jsonb,
  status text not null default 'in_force' check (status in ('in_force', 'replaced')),
  replaced_by uuid references decision_rationales(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists rule_verdicts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  standing_rule_id uuid not null references standing_rules(id) on delete cascade,
  subject text not null check (subject in ('change_request', 'signal', 'candidate', 'adr_alternative', 'drift')),
  change_request_id uuid references change_requests(id) on delete cascade,
  signal_id uuid references signals(id) on delete cascade,
  candidate_id uuid references architecture_candidates(id) on delete cascade,
  design_document_id uuid references design_documents(id) on delete cascade,
  code_artifact_id uuid references code_artifacts(id) on delete cascade,
  option_key text not null,
  option_text text not null,
  claimed_ending text,
  result text not null check (result in ('holds', 'breaks', 'replaces')),
  reason text not null,
  replacement_decision_id uuid references decision_rationales(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists design_provenance (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  design_document_id uuid not null references design_documents(id) on delete cascade,
  element_key text not null,
  element_label text,
  origin text not null check (origin in ('model_unchanged', 'model_edited', 'architect')),
  source_candidate_id uuid references architecture_candidates(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (design_document_id, element_key)
);

alter table drift_events
  add column if not exists rule_verdict_id uuid references rule_verdicts(id) on delete set null;

alter table standing_rules enable row level security;
alter table rule_verdicts enable row level security;
alter table design_provenance enable row level security;

drop policy if exists standing_rules_rw on standing_rules;
create policy standing_rules_rw on standing_rules for all
  using (is_project_member(project_id)) with check (is_project_member(project_id));

drop policy if exists rule_verdicts_rw on rule_verdicts;
create policy rule_verdicts_rw on rule_verdicts for all
  using (is_project_member(project_id)) with check (is_project_member(project_id));

drop policy if exists design_provenance_rw on design_provenance;
create policy design_provenance_rw on design_provenance for all
  using (is_project_member(project_id)) with check (is_project_member(project_id));

create index if not exists standing_rules_project_status on standing_rules (project_id, status);
create index if not exists rule_verdicts_document on rule_verdicts (design_document_id, created_at desc);
create index if not exists rule_verdicts_change on rule_verdicts (change_request_id);
create index if not exists rule_verdicts_candidate on rule_verdicts (candidate_id);
create index if not exists design_provenance_document on design_provenance (design_document_id);

create or replace function keelrace_fill_allowed_endings() returns trigger as $$
begin
  if NEW.allowed_endings is null or array_length(NEW.allowed_endings, 1) is null then
    select coalesce(array_agg(piece), '{}') into NEW.allowed_endings
    from (
      select trim(regexp_replace(trim(s), '^or\s+', '', 'i')) as piece
      from regexp_split_to_table(coalesce(NEW.ends_when, ''), '\s*,\s*|\s+or\s+') as s
      where length(trim(regexp_replace(trim(s), '^or\s+', '', 'i'))) >= 3
    ) parts;
  end if;
  -- A foreign key clearing replaced_by (the replacement decision was deleted)
  -- must not raise. A person setting status to replaced with no decision still does.
  if TG_OP = 'UPDATE' then
    if OLD.replaced_by is not null and NEW.replaced_by is null then
      return NEW;
    end if;
  end if;
  if NEW.status = 'replaced' and NEW.replaced_by is null then
    raise exception 'replacing a standing rule requires the decision that retires it';
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_standing_rule_endings on standing_rules;
create trigger trg_standing_rule_endings
  before insert or update on standing_rules
  for each row execute function keelrace_fill_allowed_endings();

-- ON DELETE SET NULL of replaced_by would trip the trigger above. Skip that
-- update path: a deleted replacement decision leaves the rule row to cascade
-- with its owning decision instead. The check above only runs on direct writes.

create or replace function classify_option(p_allowed text[], p_claimed text, p_option_text text)
returns jsonb language plpgsql immutable as $$
declare
  claimed text := lower(trim(coalesce(p_claimed, '')));
  opt text := lower(coalesce(p_option_text, ''));
  haystack text := opt || ' ' || claimed;
  ending text;
  mech text;
  mechanisms text[] := array[
    'ttl', 'time-to-live', 'time to live', 'expire', 'expiry', 'timer',
    'delete the row', 'deletes the row', 'deletes the hold', 'delete the hold'
  ];
  holds_phrases text[] := array[
    'same terminal event', 'the rule already', 'already allowed',
    'allowed ending', 'uses the existing ending'
  ];
  phrase text;
begin
  foreach mech in array mechanisms loop
    if position(mech in haystack) > 0 and not exists (
      select 1 from unnest(coalesce(p_allowed, array[]::text[])) a where position(mech in lower(a)) > 0
    ) then
      return jsonb_build_object(
        'result', 'breaks',
        'reason', 'This option introduces "' || mech || '", which is not an allowed way for the rule to end.'
      );
    end if;
  end loop;

  if length(trim(coalesce(p_option_text, '') || ' ' || coalesce(p_claimed, ''))) = 0 then
    return jsonb_build_object(
      'result', 'breaks',
      'reason', 'This option does not name which allowed ending it uses.'
    );
  end if;

  foreach phrase in array holds_phrases loop
    if position(phrase in haystack) > 0 then
      return jsonb_build_object(
        'result', 'holds',
        'reason', 'This option uses an ending the rule already allows.'
      );
    end if;
  end loop;

  foreach ending in array coalesce(p_allowed, array[]::text[]) loop
    if length(trim(ending)) >= 8 and (
      position(lower(trim(ending)) in haystack) > 0
      or (length(claimed) >= 8 and position(claimed in lower(trim(ending))) > 0)
    ) then
      return jsonb_build_object(
        'result', 'holds',
        'reason', 'This option ends the rule in a way the rule already allows: ' || trim(ending) || '.'
      );
    end if;
  end loop;

  if length(claimed) > 0 then
    return jsonb_build_object(
      'result', 'breaks',
      'reason', 'This option ends the rule by "' || trim(coalesce(p_claimed, '')) || '", which is not an allowed ending.'
    );
  end if;

  return jsonb_build_object(
    'result', 'breaks',
    'reason', 'This option does not name which allowed ending it uses.'
  );
end;
$$;

create or replace function covers_overlap(p_rule jsonb, p_opt jsonb, p_text text)
returns boolean language plpgsql immutable as $$
declare
  label text;
begin
  if p_rule is null then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_rule->'component_ids', '[]'::jsonb)) a
    join jsonb_array_elements_text(coalesce(p_opt->'component_ids', '[]'::jsonb)) b on lower(a) = lower(b)
  ) then
    return true;
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_rule->'artifact_ids', '[]'::jsonb)) a
    join jsonb_array_elements_text(coalesce(p_opt->'artifact_ids', '[]'::jsonb)) b on lower(a) = lower(b)
  ) then
    return true;
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_rule->'config_keys', '[]'::jsonb)) a
    join jsonb_array_elements_text(coalesce(p_opt->'config_keys', '[]'::jsonb)) b on lower(a) = lower(b)
  ) then
    return true;
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_rule->'paths', '[]'::jsonb)) rp
    join jsonb_array_elements_text(coalesce(p_opt->'paths', '[]'::jsonb)) op
      on lower(op) = lower(rp)
      or lower(op) like lower(rp) || '%'
      or lower(rp) like lower(op) || '%'
  ) then
    return true;
  end if;

  for label in select jsonb_array_elements_text(coalesce(p_rule->'labels', '[]'::jsonb))
  loop
    if length(label) >= 3 and position(lower(label) in lower(coalesce(p_text, ''))) > 0 then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

create or replace function write_rule_verdicts(
  p_project_id uuid,
  p_subject text,
  p_options jsonb,
  p_change_request_id uuid default null,
  p_signal_id uuid default null,
  p_candidate_id uuid default null,
  p_design_document_id uuid default null,
  p_code_artifact_id uuid default null
) returns setof rule_verdicts
language plpgsql security definer set search_path = public as $$
declare
  opt record;
  rule standing_rules;
  verdict jsonb;
  opt_covers jsonb;
begin
  if auth.uid() is not null and not is_project_member(p_project_id) then
    raise exception 'not a project member';
  end if;
  if p_subject not in ('change_request', 'signal', 'candidate', 'adr_alternative', 'drift') then
    raise exception 'unknown verdict subject %', p_subject;
  end if;

  for opt in
    select *
    from jsonb_to_recordset(coalesce(p_options, '[]'::jsonb)) as x(
      option_key text,
      option_text text,
      claimed_ending text,
      covers jsonb
    )
  loop
    opt_covers := coalesce(opt.covers, '{}'::jsonb);
    for rule in
      select * from standing_rules
      where project_id = p_project_id and status = 'in_force'
    loop
      if not covers_overlap(rule.covers, opt_covers, coalesce(opt.option_text, '') || ' ' || coalesce(opt.claimed_ending, '')) then
        continue;
      end if;
      if exists (
        select 1 from rule_verdicts v
        where v.standing_rule_id = rule.id
          and v.option_key = opt.option_key
          and v.subject = p_subject
          and v.design_document_id is not distinct from p_design_document_id
          and v.change_request_id is not distinct from p_change_request_id
          and v.signal_id is not distinct from p_signal_id
          and v.candidate_id is not distinct from p_candidate_id
          and v.code_artifact_id is not distinct from p_code_artifact_id
      ) then
        continue;
      end if;

      verdict := classify_option(rule.allowed_endings, opt.claimed_ending, opt.option_text);
      return query
      insert into rule_verdicts (
        project_id, standing_rule_id, subject,
        change_request_id, signal_id, candidate_id, design_document_id, code_artifact_id,
        option_key, option_text, claimed_ending, result, reason
      ) values (
        p_project_id, rule.id, p_subject,
        p_change_request_id, p_signal_id, p_candidate_id, p_design_document_id, p_code_artifact_id,
        opt.option_key, coalesce(opt.option_text, ''), opt.claimed_ending,
        verdict->>'result', verdict->>'reason'
      )
      returning *;
    end loop;
  end loop;
end;
$$;

create or replace function replace_standing_rule(
  p_rule_id uuid,
  p_replacement_decision_id uuid,
  p_reason text
) returns standing_rules
language plpgsql security definer set search_path = public as $$
declare
  rule standing_rules;
  repl decision_rationales;
begin
  select * into rule from standing_rules where id = p_rule_id for update;
  if rule.id is null then
    raise exception 'standing rule % not found', p_rule_id;
  end if;
  if auth.uid() is not null and not is_project_member(rule.project_id) then
    raise exception 'not a project member';
  end if;
  if rule.status = 'replaced' then
    return rule;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'replacing a rule requires a written reason';
  end if;
  select * into repl from decision_rationales where id = p_replacement_decision_id;
  if repl.id is null then
    raise exception 'replacement decision % not found', p_replacement_decision_id;
  end if;
  if repl.id = rule.decision_rationale_id then
    raise exception 'a rule cannot be replaced by the decision that created it';
  end if;

  update standing_rules
    set status = 'replaced', replaced_by = repl.id
    where id = rule.id
    returning * into rule;

  insert into rule_verdicts (
    project_id, standing_rule_id, subject, option_key, option_text,
    result, reason, replacement_decision_id
  ) values (
    rule.project_id, rule.id, 'adr_alternative',
    'replace:' || repl.id::text,
    trim(p_reason),
    'replaces',
    trim(p_reason),
    repl.id
  );

  return rule;
end;
$$;

-- Fills verdicts for the options currently on a document. Returns how many
-- of those current options break a rule that is still in force.
-- Older verdicts stay in the table and do not block once their option is gone
-- or the rule has been replaced.
create or replace function keelrace_check_document_rules(p_document_id uuid, p_project_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  dr record;
  alt jsonb;
  idx int;
  opt_key text;
  opt_text text;
  covers jsonb;
  comp_name text;
  breaking int;
  current_keys text[] := '{}';
begin
  for dr in
    select * from decision_rationales where design_document_id = p_document_id
  loop
    select c.name into comp_name from components c where c.id = dr.component_id;
    covers := jsonb_build_object(
      'component_ids', case when dr.component_id is null then '[]'::jsonb else jsonb_build_array(dr.component_id::text) end,
      'artifact_ids', '[]'::jsonb,
      'paths', '[]'::jsonb,
      'config_keys', '[]'::jsonb,
      'labels', case when comp_name is null then '[]'::jsonb else jsonb_build_array(comp_name) end
    );

    current_keys := current_keys || (dr.id::text || ':chosen');
    perform write_rule_verdicts(
      p_project_id,
      'adr_alternative',
      jsonb_build_array(jsonb_build_object(
        'option_key', dr.id::text || ':chosen',
        'option_text', dr.chosen_option,
        'claimed_ending', dr.chosen_option,
        'covers', covers
      )),
      null, null, null, p_document_id, null
    );

    idx := 0;
    for alt in select * from jsonb_array_elements(coalesce(dr.alternatives_considered, '[]'::jsonb))
    loop
      opt_text := coalesce(alt->>'option', '');
      opt_key := dr.id::text || ':alt:' || idx::text || ':' || md5(opt_text);
      current_keys := current_keys || opt_key;
      perform write_rule_verdicts(
        p_project_id,
        'adr_alternative',
        jsonb_build_array(jsonb_build_object(
          'option_key', opt_key,
          'option_text', opt_text,
          'claimed_ending', opt_text,
          'covers', covers
        )),
        null, null, null, p_document_id, null
      );
      idx := idx + 1;
    end loop;
  end loop;

  select count(*) into breaking
  from rule_verdicts v
  join standing_rules sr on sr.id = v.standing_rule_id
  where v.design_document_id = p_document_id
    and sr.status = 'in_force'
    and v.result = 'breaks'
    and v.option_key = any(current_keys);
  return breaking;
end;
$$;

create or replace function keelrace_provenance_on_component_edit() returns trigger as $$
begin
  if TG_OP = 'UPDATE' and NEW.description is distinct from OLD.description then
    update design_provenance
      set origin = 'model_edited'
      where design_document_id = NEW.hld_document_id
        and element_key = NEW.family_key
        and origin = 'model_unchanged';
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_provenance_component_edit on components;
create trigger trg_provenance_component_edit
  before update on components
  for each row execute function keelrace_provenance_on_component_edit();

-- approve_design_document: previous body from 0025, plus the standing-rule gate.
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
  v_breaking int;
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

  v_breaking := keelrace_check_document_rules(p_document_id, v_project_id);
  if v_breaking > 0 then
    raise exception 'cannot approve design_document %: % option(s) break a standing rule. Rewrite the option or record a decision that replaces the rule.', p_document_id, v_breaking;
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

grant execute on function classify_option(text[], text, text) to authenticated;
grant execute on function covers_overlap(jsonb, jsonb, text) to authenticated;
grant execute on function write_rule_verdicts(uuid, text, jsonb, uuid, uuid, uuid, uuid, uuid) to authenticated;
grant execute on function replace_standing_rule(uuid, uuid, text) to authenticated;
grant execute on function keelrace_check_document_rules(uuid, uuid) to authenticated;
grant execute on function approve_design_document(uuid, uuid) to authenticated;
