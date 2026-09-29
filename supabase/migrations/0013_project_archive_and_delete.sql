-- Project archive + hard delete (UI in ProjectList)
alter table projects add column if not exists archived_at timestamptz;

create index if not exists projects_archived_at_idx on projects (archived_at);

drop policy if exists projects_delete_architect on projects;
notify pgrst, 'reload schema';
