-- KeelRace: Migration 0007
--   * code_artifacts gets real versioning. Previously `unique(project_id, path)`
--     meant a second "Skeleton" run against the same project collided with
--     itself on almost every file and landed in generate-skeleton's
--     `rejected` list -- there was no update/new-version path, unlike
--     design_documents. Skeleton generation now behaves like design-doc
--     generation: each run is a new, complete generation_version; nothing
--     is overwritten, and old generations stay inspectable.

alter table code_artifacts drop constraint if exists code_artifacts_project_id_path_key;
alter table code_artifacts add column if not exists generation_version int not null default 1;
alter table code_artifacts add constraint code_artifacts_project_path_version_key unique (project_id, path, generation_version);

create index if not exists idx_code_artifacts_project_version on code_artifacts (project_id, generation_version);
