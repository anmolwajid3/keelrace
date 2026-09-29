-- Profile skeleton destination + replayable loop runs.

alter table profiles
  add column if not exists skeleton_destination text not null default 'download',
  add column if not exists github_repo text;

alter table profiles
  drop constraint if exists profiles_skeleton_destination_check;
alter table profiles
  add constraint profiles_skeleton_destination_check
  check (skeleton_destination in ('download', 'gist'));

create table if not exists loop_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  label text not null,
  record jsonb not null
);

alter table loop_runs enable row level security;

create policy loop_runs_select on loop_runs for select using (is_project_member(project_id));
create policy loop_runs_insert on loop_runs for insert with check (is_project_member(project_id));
-- no update/delete: a run is a replay record, not a working copy
