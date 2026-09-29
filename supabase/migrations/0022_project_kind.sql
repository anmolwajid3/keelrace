alter table projects add column if not exists kind text not null default 'live';
alter table projects drop constraint if exists projects_kind_check;
alter table projects add constraint projects_kind_check check (kind in ('live', 'demo'));
