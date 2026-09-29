-- KeelRace: Migration 0003 -- supports DesignChatThread grounding (FR-1.2)
-- and a couple of lookups the new UI needs.

-- Let a client find/reuse the single thread for a given decision_rationale
-- without a race (used by the design-chat edge function).
alter table design_chat_threads add column if not exists title text;

create unique index if not exists idx_one_thread_per_rationale
  on design_chat_threads (decision_rationale_id);

-- Helpful for "find a teammate by email" in the invite UI.
create index if not exists idx_profiles_email on profiles (email);

-- Tighten project_members insert: the original policy's "or true" fallback
-- (meant only to bootstrap the creator's first row) actually let ANY
-- authenticated user add themselves to ANY project. Replace it with a real
-- check: either you're already a member (inviting someone else in), or
-- you're the project's creator adding yourself for the first time.
drop policy if exists project_members_insert on project_members;
create policy project_members_insert on project_members for insert with check (
  is_project_member(project_id)
  or (user_id = auth.uid() and exists (select 1 from projects p where p.id = project_id and p.created_by = auth.uid()))
);

-- Members should also be removable by other members (e.g. correcting a bad invite).
create policy project_members_delete on project_members for delete using (is_project_member(project_id));
