-- Architect-assist layer: proposals, not authority.
-- Models may write proposed/open rows. Humans accept, reject, or dismiss.
-- Nothing here sets design_documents.status or requirement_sets.status.

create table if not exists architecture_knowledge (
  id uuid primary key default gen_random_uuid(),
  framework text not null,
  category text not null,
  title text not null,
  body text not null,
  search_text tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) stored
);

create index if not exists architecture_knowledge_fts on architecture_knowledge using gin (search_text);

alter table architecture_knowledge enable row level security;
create policy architecture_knowledge_read on architecture_knowledge for select to authenticated using (true);

create table if not exists architectural_drivers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  requirement_set_id uuid references requirement_sets(id) on delete cascade,
  quality_attribute text not null,
  title text not null,
  stimulus text,
  environment text,
  response text,
  source_requirement_ids uuid[] not null default '{}',
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  grounding jsonb not null default '[]'::jsonb,
  confidence text not null default 'partial' check (confidence in ('grounded', 'partial', 'ungrounded')),
  questions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists architecture_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  requirement_set_id uuid references requirement_sets(id) on delete cascade,
  name text not null,
  summary text,
  optimizes text,
  sacrifices text,
  components jsonb not null default '[]'::jsonb,
  mermaid text,
  mermaid_valid boolean not null default false,
  grounding jsonb not null default '[]'::jsonb,
  confidence text not null default 'partial' check (confidence in ('grounded', 'partial', 'ungrounded')),
  questions jsonb not null default '[]'::jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'selected', 'discarded')),
  created_at timestamptz not null default now()
);

create table if not exists assist_findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in (
    'critic', 'challenger', 'scenario', 'mapping', 'question', 'brief', 'note'
  )),
  severity text not null default 'info' check (severity in ('info', 'low', 'medium', 'high')),
  title text not null,
  body text,
  suggested_rewrite text,
  target jsonb not null default '{}'::jsonb,
  grounding jsonb not null default '[]'::jsonb,
  confidence text not null default 'partial' check (confidence in ('grounded', 'partial', 'ungrounded')),
  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed', 'applied')),
  created_at timestamptz not null default now()
);

create table if not exists assist_adr_drafts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  design_document_id uuid references design_documents(id) on delete set null,
  decision_point text not null,
  chosen_option text not null default '',
  alternatives jsonb not null default '[]'::jsonb,
  suggested_requirement_ids uuid[] not null default '{}',
  consequences text,
  grounding jsonb not null default '[]'::jsonb,
  confidence text not null default 'partial',
  questions jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'recorded', 'discarded')),
  created_at timestamptz not null default now()
);

create table if not exists assist_ask_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table architectural_drivers enable row level security;
alter table architecture_candidates enable row level security;
alter table assist_findings enable row level security;
alter table assist_adr_drafts enable row level security;
alter table assist_ask_messages enable row level security;

create policy architectural_drivers_rw on architectural_drivers for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy architecture_candidates_rw on architecture_candidates for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy assist_findings_rw on assist_findings for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy assist_adr_drafts_rw on assist_adr_drafts for all using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy assist_ask_messages_rw on assist_ask_messages for all using (is_project_member(project_id)) with check (is_project_member(project_id));

create index if not exists architectural_drivers_project on architectural_drivers (project_id, status);
create index if not exists architecture_candidates_project on architecture_candidates (project_id, status);
create index if not exists assist_findings_project_kind on assist_findings (project_id, kind, status);
create index if not exists assist_adr_drafts_project on assist_adr_drafts (project_id);
create index if not exists assist_ask_messages_project on assist_ask_messages (project_id, created_at);

insert into architecture_knowledge (framework, category, title, body) values
('ADD 3.0', 'method', 'Architectural drivers come before structure',
 'Attribute-Driven Design treats quality-attribute scenarios as the input to decomposition. A driver names a stimulus, environment, and measurable response. Do not invent a component split until the architect has accepted the drivers that matter.'),
('ADD 3.0', 'method', 'Iterate tactics, then allocate',
 'For each driver, consider architectural tactics (e.g. replication for availability, checkpoint for recoverability) then allocate responsibilities to elements. Record rejected tactics as alternatives on the decision, not only the winner.'),
('ISO 25010', 'quality', 'Quality model for NFRs',
 'ISO/IEC 25010 groups product quality into characteristics such as performance efficiency, reliability, security, compatibility, maintainability, usability, and portability. Map each NFR to one primary characteristic so trade-offs are visible.'),
('ISO 29148', 'requirements', 'Requirements must be verifiable',
 'ISO/IEC/IEEE 29148: a requirement should be singular, verifiable, and free of implementation unless the implementation is the constraint. Compound sentences with multiple ANDs usually hide two requirements.'),
('ATAM', 'evaluation', 'Utility tree and scenarios',
 'ATAM organizes quality concerns in a utility tree and evaluates architecture with scenarios. Sensitivity points and trade-off points are findings for the architect, not automatic scores. Unstable numeric scores should not gate approval.'),
('SAAM', 'evaluation', 'Scenario walkthroughs',
 'SAAM walks use-case and change scenarios through the architecture to see which elements are affected. Generate candidate scenarios; the architect decides which are in the evaluation boundary.'),
('Bass tactics', 'tactic', 'Availability tactics',
 'Common availability tactics: ping/echo, heartbeat, active redundancy, passive redundancy, checkpoint/rollback, exception detection, isolation. Each has cost. Prefer naming the tactic and the quality it serves.'),
('Bass tactics', 'tactic', 'Performance tactics',
 'Performance tactics include reduce computational overhead, manage sampling rate, bound queue sizes, increase resources, introduce concurrency, maintain multiple copies of data. State the response measure (latency, throughput) the tactic is for.'),
('Bass tactics', 'tactic', 'Modifiability and security tactics',
 'Modifiability: increase semantic coherence, encapsulate, use an intermediary, restrict communication paths. Security: authenticate actors, authorize, limit exposure, detect intrusion. Do not apply a tactic that the drivers do not demand — that is over-engineering.'),
('Pattern', 'style', 'Modular monolith vs services',
 'A modular monolith keeps a single deployable with enforced module boundaries; services add independent deployability at the cost of operational complexity and data consistency. Choose services when independent scale, team autonomy, or failure isolation is an accepted driver — not by default.'),
('Pattern', 'style', 'Event-driven backbone',
 'Event-driven integration decouples producers from consumers but makes end-to-end consistency and debugging harder. Use when drivers include independent evolution of producers and eventual consistency is acceptable.'),
('AWS Well-Architected', 'practice', 'Do not copy cloud topology by default',
 'Well-Architected pillars (operational excellence, security, reliability, performance, cost, sustainability) are questions, not a mandate to add a cloud region. If CON forbids a network, do not introduce a cloud control plane.'),
('ADR', 'knowledge', 'MADR fields',
 'An architecture decision record should capture context, the decision, alternatives with reasons they were rejected, and consequences. Leave the chosen option empty until a human fills it. Cite the drivers or requirements that force the choice.'),
('Ozkaya', 'practice', 'As-built is context',
 'Architecture knowledge includes the implemented system. Mapping code to the approved design is a proposal. Identity of components must stay a foreign key the architect confirms, never a filename heuristic as the source of truth.');
