-- Event schemas may now record a real breaking_change result (was forced null).
alter table service_contracts drop constraint if exists event_schema_null_breaking;
