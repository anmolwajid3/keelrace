-- KeelRace: Migration 0011
--   * design_documents.requirements_hash (HLD rows only) lets the client
--     detect "you're regenerating from the exact same requirements as last
--     time" and confirm before creating a version that's identical in
--     substance -- generation was previously unconditional, so every
--     regenerate created a new version even with zero requirement changes.

alter table design_documents add column if not exists requirements_hash text;