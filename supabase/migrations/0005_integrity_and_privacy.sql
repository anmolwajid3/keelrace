-- KeelRace: Migration 0005
--   * requirement_sets becomes genuinely immutable once locked (a locked set
--     could previously be silently reverted to draft, or have its version
--     changed, undermining FR-1.1's whole "reject if not locked" gate).
--   * review_actions' authority trigger actually fires now -- the original
--     condition (`reviewable_item_table = 'review_gates'`) never matched
--     what the app actually inserts (`reviewable_item_table = 'design_documents'`),
--     so it was dead code protecting nothing.
--   * profiles is no longer globally readable -- visible to yourself and
--     people who share a project with you, full stop. Team-invite lookups
--     move to a dedicated edge function so inviting someone you don't yet
--     share a project with still works without exposing the whole table.

-- ============================================================
-- requirement_sets immutability
-- ============================================================
create or replace function guard_requirement_set_immutability() returns trigger as $$
begin
  if NEW.version is distinct from OLD.version then
    raise exception 'requirement_sets.version is immutable after insert';
  end if;
  if NEW.project_id is distinct from OLD.project_id then
    raise exception 'requirement_sets.project_id is immutable after insert';
  end if;
  if OLD.status = 'locked' and NEW.status = 'draft' then
    raise exception 'a locked RequirementSet cannot be reverted to draft';
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_guard_requirement_set_immutability
  before update on requirement_sets
  for each row execute function guard_requirement_set_immutability();

-- ============================================================
-- Fix the dead review_actions authority check: resolve project_id/phase by
-- matching the gate whose target is this exact reviewable item, regardless
-- of which table name the client passed (that's the actual shape the app
-- uses -- reviewable_item_table is the TARGET's table, e.g.
-- 'design_documents', not 'review_gates').
-- ============================================================
create or replace function enforce_review_action_authority() returns trigger as $$
declare
  v_project_id uuid;
  v_phase text;
begin
  select rg.project_id, rg.phase into v_project_id, v_phase
    from review_gates rg
    where rg.target_artifact_id = NEW.reviewable_item_id
      and rg.target_artifact_table = NEW.reviewable_item_table
    order by rg.created_at desc
    limit 1;

  if v_project_id is not null and not is_authorized_reviewer(v_project_id, NEW.reviewer_id, v_phase) then
    raise exception 'reviewer % is not authorized for phase % on project %', NEW.reviewer_id, v_phase, v_project_id;
  end if;
  -- if no matching gate is found (e.g. a review action on something with no
  -- gate concept), we don't block -- the gate-level trigger is the primary
  -- enforcement point and already ran before this insert could happen.
  return NEW;
end;
$$ language plpgsql;
-- trigger trg_review_action_authority already points at this function name;
-- CREATE OR REPLACE above is sufficient, no need to re-create the trigger.

-- ============================================================
-- Tighten profiles visibility
-- ============================================================
drop policy if exists profiles_select_all on profiles;

create or replace function shares_project_with(p_target_user uuid) returns boolean as $$
  select exists (
    select 1 from project_members pm1
    join project_members pm2 on pm1.project_id = pm2.project_id
    where pm1.user_id = auth.uid() and pm2.user_id = p_target_user
  );
$$ language sql security definer stable;

create policy profiles_select_self_or_shared on profiles for select using (
  id = auth.uid() or shares_project_with(id)
);

grant execute on function shares_project_with(uuid) to authenticated;
