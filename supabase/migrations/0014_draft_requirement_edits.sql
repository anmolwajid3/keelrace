-- Draft requirement sets may be edited; locked sets stay immutable (use Changes & Signals).
create policy requirements_update_draft on requirements for update using (
  exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_set_id
      and is_project_member(rs.project_id)
      and rs.status = 'draft'
  )
) with check (
  exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_set_id
      and is_project_member(rs.project_id)
      and rs.status = 'draft'
  )
);

create policy requirements_delete_draft on requirements for delete using (
  exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_set_id
      and is_project_member(rs.project_id)
      and rs.status = 'draft'
  )
);

create or replace function requirements_only_while_draft()
returns trigger as $$
declare
  set_status requirement_set_status;
begin
  select status into set_status
  from requirement_sets
  where id = coalesce(NEW.requirement_set_id, OLD.requirement_set_id);

  if set_status = 'locked' then
    raise exception 'Locked requirement sets cannot be edited. Use a Change Request.';
  end if;
  return coalesce(NEW, OLD);
end;
$$ language plpgsql;

drop trigger if exists requirements_draft_only on requirements;
create trigger requirements_draft_only
  before update or delete on requirements
  for each row execute function requirements_only_while_draft();
