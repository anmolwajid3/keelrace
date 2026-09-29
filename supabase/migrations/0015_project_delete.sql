-- Restore project delete: 0013 dropped projects_delete_architect and never
-- recreated it, so RLS returned 0 rows with no error. Child tables also lack
-- DELETE policies / some FKs have no ON DELETE, so client DELETE FROM projects
-- cannot cascade. A security-definer RPC deletes as table owner after an
-- architect/creator check.

drop policy if exists projects_delete_architect on projects;
create policy projects_delete_architect on projects for delete using (
  created_by = auth.uid()
  or has_project_role(id, 'architect')
);

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

  update change_requests
    set resolved_document_version_id = null, target_requirement_id = null
    where project_id = p_id;
  update signals
    set resolved_document_version_id = null, routed_to_requirement_id = null
    where project_id = p_id;
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

  delete from design_documents where requirement_set_id in (
    select id from requirement_sets where project_id = p_id
  );

  delete from projects where id = p_id;
  return p_id;
end;
$$;

revoke all on function delete_own_project(uuid) from public;
grant execute on function delete_own_project(uuid) to authenticated;

notify pgrst, 'reload schema';
