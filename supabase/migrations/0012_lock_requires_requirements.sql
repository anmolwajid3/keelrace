-- KeelRace: Migration 0012
--   * A RequirementSet could previously be locked with zero requirements in
--     it -- and once locked, there was no way to add any, since the UI only
--     renders the add/import forms for non-locked sets. Blocks the
--     draft -> locked transition at the data layer when the set has no
--     requirements, so this can't happen again regardless of what the UI
--     does or doesn't render.

create or replace function guard_lock_requires_requirements() returns trigger as $$
declare
  v_count int;
begin
  if NEW.status = 'locked' and OLD.status is distinct from 'locked' then
    select count(*) into v_count from requirements where requirement_set_id = NEW.id;
    if v_count = 0 then
      raise exception 'cannot lock requirement_set %: it has no requirements yet', NEW.id;
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_guard_lock_requires_requirements
  before update on requirement_sets
  for each row execute function guard_lock_requires_requirements();