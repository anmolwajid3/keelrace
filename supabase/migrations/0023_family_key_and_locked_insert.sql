-- Mint family_key on component insert when the client omits it.
-- Block inserts into a locked requirement set (0014 only covered update/delete).

create or replace function fill_component_family_key() returns trigger as $$
begin
  if NEW.family_key is null or btrim(NEW.family_key) = '' then
    NEW.family_key := next_component_key(NEW.project_id);
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_fill_component_family_key on components;
create trigger trg_fill_component_family_key
  before insert on components
  for each row execute function fill_component_family_key();

drop trigger if exists requirements_draft_only on requirements;
create trigger requirements_draft_only
  before insert or update or delete on requirements
  for each row execute function requirements_only_while_draft();

drop policy if exists requirements_insert on requirements;
create policy requirements_insert on requirements for insert with check (
  exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_set_id
      and is_project_member(rs.project_id)
      and rs.status = 'draft'
  )
);
