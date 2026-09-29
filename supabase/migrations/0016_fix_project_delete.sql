-- delete_own_project used to null change_requests.target_requirement_id,
-- which violates target_required_for_modify_remove on modify/remove rows.
-- Delete change/signal rows instead of blanking the required target.

create or replace function delete_own_project(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from projects p
    where p.id = p_id
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from project_members pm
          where pm.project_id = p_id
            and pm.user_id = auth.uid()
            and pm.role = 'architect'
        )
      )
  ) then
    raise exception 'You must be the creator or an architect to delete this project';
  end if;

  delete from change_impact_traces
    where change_request_id in (select id from change_requests where project_id = p_id)
       or signal_id in (select id from signals where project_id = p_id);

  delete from triage_decisions
    where change_request_id in (select id from change_requests where project_id = p_id)
       or signal_id in (select id from signals where project_id = p_id);

  delete from change_requests where project_id = p_id;
  delete from signals where project_id = p_id;

  update nfrs set component_id = null where project_id = p_id;

  update design_documents dd
    set superseded_by = null, component_id = null
  from requirement_sets rs
  where dd.requirement_set_id = rs.id and rs.project_id = p_id;

  delete from prototypes where design_document_id in (
    select dd.id from design_documents dd
    join requirement_sets rs on rs.id = dd.requirement_set_id
    where rs.project_id = p_id
  );

  delete from threat_models where design_document_id in (
    select dd.id from design_documents dd
    join requirement_sets rs on rs.id = dd.requirement_set_id
    where rs.project_id = p_id
  );

  delete from design_documents where requirement_set_id in (
    select id from requirement_sets where project_id = p_id
  );

  delete from projects where id = p_id;
  return p_id;
end;
$$;
