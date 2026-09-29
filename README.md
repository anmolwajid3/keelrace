# KeelRace — Ideal Software Architecture System

**KeelRace**: *keel* — the structural backbone everything else is built on and traced
back to — plus *-race*, the fixed track (as in a bearing race) that a change or decision
runs along through review, impact scoping, triage, and approval before it's allowed to land.

Implements the Structured Requirements Spec (v2): requirements → HLD/LLD generation,
human review gates, starter-code generation, drift detection, an ADR ledger, diagrams,
early-problem checks (NFR/risk), cross-team contracts, ongoing governance, and the
two-door change-handling flow (FR-10).

## Stack
- **Database:** Supabase Postgres, full RLS
- **Backend logic:** Supabase Edge Functions (Deno), calling **OpenRouter** for LLM generation
- **Frontend:** React + Vite, `@supabase/supabase-js`

## Project layout
```
supabase/
  migrations/0001_init.sql   -- full schema, enums, constraints, RLS
  functions/                 -- one folder per edge function
frontend/                    -- React/Vite app
```

## 1. Deploy the database

You already have a project: `iurumoifshwwycgbnvpz`.

```bash
npm install -g supabase   # if you don't have the CLI
supabase login
cd keelrace
supabase link --project-ref iurumoifshwwycgbnvpz
supabase db push           # runs all ten migrations, in order
```

Or: open the Supabase SQL Editor for this project and run, in order:
`0001_init.sql` through `0010_lld_reconciliation_gate.sql`. Order matters — each depends on
the one before it. **0004 drops and recreates** `code_artifacts.design_component_id`,
`team_boundaries.design_component_id`, and `deprecation_records.design_component_id` to point at the new
`components` table instead of `decision_rationales` — if you have pre-0004 data in those columns, it will
be dropped; re-link through the UI afterward. **0005 removes the previous global `profiles` read policy**
— after this, inviting someone by email goes through the `lookup-invitee` edge function, not a direct
table select. **0006 redefines `approve_design_document()`** to move supersession from generation-time to
approval-time — if you generated documents between deploying 0004 and 0006, check the Design Docs tab for
any HLD/LLD marked `superseded` that never actually got replaced by an approved version, and fix by hand
(set it back to `approved`, clear `superseded_by`) since that's exactly the regression this migration fixes.
**0007 changes `code_artifacts`' uniqueness** from `(project_id, path)` to `(project_id, path,
generation_version)` — if you already generated a skeleton before this migration, it becomes
`generation_version = 1` automatically; regenerating after upgrading produces `generation_version = 2`, etc.
**0008 backfills `family_key`** for any components created before this migration (each gets its own id as
its family_key, i.e. treated as having no matchable history) and redefines `approve_design_document()`
again, this time for per-component NFR scoping and the reconciliation gate. **0009 replaces the random
`family_key` format with a sequential, alphanumeric-only one** (`CMP0001`, `CMP0002`, ...) generated via a
per-project counter (`next_component_key()`, safe under concurrent calls), and re-backfills any
pre-existing components onto the new format. **0010 redefines `approve_design_document()`** once more, to
extend the component-reconciliation gate (previously HLD-only) to also block LLD approval when its parent
HLD has an unconfirmed reconciliation pending.

## 2. Deploy the edge functions

```bash
supabase functions deploy generate-design-docs
supabase functions deploy generate-prototype
supabase functions deploy generate-skeleton
supabase functions deploy detect-drift
supabase functions deploy impact-scope
supabase functions deploy triage-change
supabase functions deploy reconverge-change
supabase functions deploy resolve-change
supabase functions deploy diff-contract
supabase functions deploy health-report
supabase functions deploy diff-snapshots
supabase functions deploy design-chat
supabase functions deploy apply-requirement-change
supabase functions deploy lookup-invitee
supabase functions deploy suggest-nfr-citations
supabase functions deploy architect-assist
```

Then set your OpenRouter key as a secret (do **not** commit it or paste it into chat):

```bash
supabase secrets set OPENROUTER_API_KEY=sk-or-...
```

The functions already have `SUPABASE_URL` and the service-role/anon keys available
automatically inside the Edge Functions runtime — you don't need to set those yourself.

Edge functions default to `anthropic/claude-sonnet-4.5` via OpenRouter's `/chat/completions`
endpoint. Change the model string in `supabase/functions/_shared/lib.ts` (`callOpenRouter`)
if you want a different one.

## 3. Run the frontend

```bash
cd frontend
npm install
npm run dev
```

`.env` is already populated with your project URL and publishable key
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`). Nothing secret lives in the
frontend — the publishable/anon key is safe to ship client-side; RLS does the
enforcement.

Sign up for an account in the app, create a project, and you're in.

## What's wired vs. still open

**Fully wired, enforced at the data layer (not just the UI):**
- FR-1.1/1.2 — HLD/LLD + decision-rationale generation, gated on `locked` status, versioned, never overwritten
- FR-1.3 — prototype generation, gated on `approved`
- FR-2.1 — a `design_document` can only become `approved` through `approve_design_document()`, which requires an
  *approved* `review_gate` targeting that exact document; a plain client-side `UPDATE ... SET status='approved'`
  is rejected by a trigger regardless of RLS
- FR-2.4 — reviewer authority is checked against `project_members.role`/`phase_scope` on every gate decision and
  review action, not assumed; unauthorized approvals raise, they don't silently succeed
- FR-3.1 — skeleton generation with a real (if heuristic) check that rejects files containing implementation bodies
- FR-3.2/3.3 — Diagram/Traceability tab: a real FK query (`code_artifacts.design_component_id`), never a
  name-match heuristic; unlinked files are shown explicitly, not dropped
- FR-4.x — deterministic drift classification + live blast-radius severity over a real dependency graph
- FR-5.x — decision ledger with full-text search, provisional/revisit-check tracking; FR-5.4 snapshot diffing is a
  real structural diff (`diff-snapshots`), and snapshots are immutable (no update policy exists on that table)
- FR-7.1/7.2/5.3 — approving a document now *fails* server-side if any project NFR is uncited (unless explicitly
  overridden), any high-risk decision lacks a completed spike, or an NFR conflict touching this document is
  unresolved — these are checks inside `approve_design_document()`, not UI validation
- FR-7.3/7.4 — real impact-scoping traversal + triage with named triggering factors
- FR-8.1 — structural OpenAPI diffing (path/method/required-field/response-field level); event schemas correctly stay `null`
- FR-8.2 — Team Boundaries tab; unowned components are flagged, not silently unrouted
- FR-9.1 — health report, every number a live query, no caching; now also surfaces topology/threat-model gaps
- FR-9.2 — dedicated Debt Backlog tab, filterable, independent of the health report
- FR-9.3 — Governance tab tracks deployment topology per environment; flags when a project has none
- FR-9.4 — a design document can be marked "crosses a trust boundary"; the Governance tab flags any such document
  with no linked `ThreatModel`
- FR-9.5 — a `deprecation_record` cannot reach `removed` while a trigger finds an active, unmigrated dependent —
  enforced in the database, not just the UI
- FR-10.1–10.5 — both entry doors, the diagnostic-only-on-Door-2 rule, and the shared reconvergence pipeline

**Deliberately left open, per the spec itself:**
- Multi-reviewer disagreement (FR-2.4)
- Live metrics ingestion (FR-5.2) — manual check-ins only
- Event-schema breaking-change diffing (FR-8.1)

**Now closed (previously flagged as gaps):**
- **Supersession moved to the correct moment.** The last round's fix for "manual regeneration didn't
  supersede" was itself a regression: it superseded the prior approved HLD/LLD at *generation* time,
  before the replacement had been reviewed — leaving a window with zero currently-approved documents.
  Supersession for plain regeneration now happens inside `approve_design_document()`, firing only once
  the new version actually clears review, matching FR-10.5's stated model ("once approved... the prior
  version becomes superseded"). The change-request flow's supersession-on-resolve (`resolve-change`)
  was already correct and is untouched.
- **`components` identity is now locked.** `name`/`hld_document_id`/`project_id` are immutable after
  insert, and two components in the same HLD can no longer share a name — both were silent corruption
  risks for the name-based matching that skeleton generation and LLD supersession depend on.
- **`drift_events.resolved_by`/`resolved_at` are auto-stamped** by a trigger the moment `resolution` is
  set, instead of sitting permanently null because the UI never set them.
- **`Signal.raised_against_artifact_id` is wired up** — the signal-report form now lets you pick which
  code artifact the finding is against, and it's shown on each signal.
- **Triage History** is now a persisted section on the Changes & Signals tab, not just a one-off card
  that disappears after you dismiss it.
- **`debt_items` gets an append-only status log** (`debt_item_status_log`, populated by trigger) — the
  current row stays mutable since it's operational state, but every transition is preserved, resolving
  the NFR-3 ambiguity around whether debt tracking should be append-only.
- **Skeleton generation is now versioned.** Previously `code_artifacts` had a plain
  `unique(project_id, path)` constraint, so regenerating a skeleton against the same project collided
  with itself on nearly every file and mostly landed in `rejected`. It's now `unique(project_id, path,
  generation_version)` — each "Skeleton" run is a complete new generation, nothing overwritten, and old
  generations stay selectable in Diagram/Traceability.
- **Generated code has a content viewer and a real export.** Traceability previously only showed file
  *paths* — you couldn't see what was actually generated, or get it out of the database at all. Each
  file now expands to show its generated content, and a "Download as .zip" button builds a real,
  cloneable folder structure from the selected generation.
- **Component identity is now stable across regenerations.** Each component gets a `family_key`
  (e.g. `CMP0001`) assigned once and carried forward — the same pattern `requirements.ref_code`
  already used across `RequirementSet` versions. On regeneration, the LLM is shown the prior HLD's
  components and asked to reuse a `family_key` when it judges a component unchanged; a
  `component_reconciliation` is recorded for the run, and any HLD with vanished (unconfirmed)
  components is blocked from approval until a human confirms the change was intentional — catching a
  bad match instead of letting it silently break downstream links. `reference_code` (`family_key` +
  creation timestamp, e.g. `CMP0001-20260922143000`) is the human-facing citation form. LLD
  supersession now matches on `family_key` too, replacing the earlier plain name-match.
- **NFRs can be scoped to a single component.** Previously every NFR applied project-wide, so
  approving *any* document required citing *every* NFR in the project regardless of relevance. An NFR
  can now be scoped to one component; `approve_design_document()`'s coverage check only requires
  citation for NFRs that are project-wide or actually in scope for the document being approved.
- **Diagrams are now actually visual**, not tabular. A shared `DiagramView` component (plain SVG,
  circular auto-layout, arrowed edges — no charting library needed) replaced the flat node badge/edge
  list previously used for prototypes, and a new Component Diagram section on each approved HLD shows
  its components with edges rolled up from file-level dependencies recorded in Diagram/Traceability.
- **`generate-design-docs` compensates for partial failures.** It's a sequence of separate PostgREST
  calls, not one database transaction — if any insert fails partway through (e.g. a component name
  collision), everything already inserted in that run (HLD, components, LLDs, decisions, gate) is now
  deleted before the error is returned, instead of leaving an orphaned draft behind.
- **`apply-requirement-change` is now idempotent and recoverable.** It calls `generate-design-docs` and
  `resolve-change` as two separate HTTP round-trips, so a failure between them used to leave a change
  silently stuck. It now: reuses a prior run's `RequirementSet`/HLD if one already exists at the target
  version instead of duplicating it, retries `resolve-change` once, and — if it still fails — returns a
  `recovery` object with the exact ids needed to finish the link by hand, plus short-circuits entirely
  if the change was already fully resolved by an earlier call.
- **The component-reconciliation gate now covers LLDs, not just HLDs.** Previously an LLD could be
  approved even while its parent HLD had an unconfirmed reconciliation pending; `approve_design_document()`
  now checks the parent HLD's reconciliation state for LLD approvals too.
- **Traceability Audit gained two partial-generation checks**: an HLD with zero components, and a
  component marked `needs_detail` with no covering LLD — both symptoms of a `generate-design-docs` run
  that died partway through, doubling as a safety net in case the compensating cleanup above ever fails
  to run cleanly itself.
- **Prototype viewer.** Generated wireframe/flow-diagram content (nodes/edges) now actually renders in
  the Design Docs tab instead of sitting unseen in the table after a "Prototype generated." alert.
- **Manual regeneration now supersedes.** Regenerating an HLD/LLD directly from the Requirements tab
  (not through the change-request flow) now marks the prior approved version `superseded` at
  generation time — previously only the `apply-requirement-change`/`resolve-change` path did this,
  so a plain re-run could leave two "live" HLDs coexisting.
- **`requirement_sets` is now genuinely immutable where it matters.** `version` and `project_id` can't
  change after insert, and a `locked` set can no longer be silently reverted to `draft` — closing a
  hole that undermined FR-1.1's whole "reject generation unless locked" gate.
- **The dead `review_actions` authority check now actually fires.** Its original condition
  (`reviewable_item_table = 'review_gates'`) never matched what the app inserts
  (`reviewable_item_table = 'design_documents'`); it's rewritten to resolve the gate by matching
  target id/table instead, so it checks what it was meant to check.
- **FR-10.1's add/remove/modify loop, fully closed.** New `apply-requirement-change` edge function: an
  approved ChangeRequest or routed `requirement_gap` Signal now produces a real new, locked
  `RequirementSet` version, regenerates design docs against it, and resolves back — `action='add'`
  previously had nowhere to go.
- **A real `components` table**, replacing the two inconsistent proxies (`hld_component_id` pointing
  only at the parent HLD, and `decision_rationales.id` standing in for component identity elsewhere).
  `code_artifacts`, `team_boundaries`, and `deprecation_records` all point at real component ids now.
- **FR-9.3's topology gap is now visible per-document**, not just project-wide in the health report —
  an approved design document with no deployment topology anywhere in the project shows an
  "incomplete" badge directly on the document.
- **NFR-4's last raw-JSON hole closed.** Deployment topology structure now renders as a table in
  Governance instead of being write-only.
- **NFR-1 has a real cross-cutting check.** New Traceability Audit tab live-verifies (rather than just
  trusting the DB constraints) that design documents trace to a RequirementSet, LLDs trace to a real
  Component, decisions cite requirements, prototypes and ThreatModels trace to a Design Document, and
  approved documents carry a reviewer — surfacing any gap instead of assuming schema constraints alone
  guarantee it.
- **`profiles` is no longer globally readable.** Previously any authenticated user could look up any
  other user's email/name. Now visible only to yourself and people who share a project with you; the
  Team tab's invite flow moved to a dedicated `lookup-invitee` edge function (exact-email match only,
  no bulk browsing) so inviting someone you don't yet share a project with still works.
- **FR-8.1 diffing runs automatically on registration** for `api`-type contracts (when a prior version
  exists), instead of being a manual step you had to remember to trigger.
- **FR-10.1 add/remove/modify loop, actually closed.** New `apply-requirement-change` edge function:
  an approved ChangeRequest or a `requirement_gap` Signal now produces a real new, locked
  `RequirementSet` version (copying forward existing requirements, applying the add/modify/remove),
  triggers `generate-design-docs` against it, and resolves back through `resolve-change`. Previously
  `action='add'` had nowhere to go and the UI asked you to manually paste a document ID.
- **A real `components` table.** Previously "component" was two inconsistent proxies:
  `design_documents.hld_component_id` (which only ever pointed at the parent HLD's own id, not an
  individual component) and `decision_rationales.id` (used as a stand-in for component identity in
  code artifacts, team boundaries, and deprecation records — but a decision isn't a component).
  `generate-design-docs` now creates one `components` row per HLD component; `code_artifacts`,
  `team_boundaries`, and `deprecation_records` all point at real component ids; decisions can
  optionally link to the component they shaped. Traceability, Team Boundaries, and skeleton
  generation were all updated to match.
- **FR-4.4 → FR-9.2 link.** Resolving a drift event as `log_as_debt` now actually inserts the
  `debt_items` row via a trigger (previously it only set a field on the drift event; debt items
  were only ever created manually).
- **FR-5.2 provisional decisions are reachable.** The ADR Ledger now has "mark provisional…", which
  sets `revisit_condition` — previously the revisit-check UI existed but nothing could produce a
  `provisional` row to check.
- **NFR-5 has real teeth.** A `code_artifacts.last_modified_at` column (updated whenever
  `content_hash` changes) plus an `unevaluated_artifacts` view surface any artifact modified more
  recently than its last `DriftEvent` — shown in Drift & Health as "unevaluated changes." This is
  what "a merge with no corresponding DriftEvent evaluation is itself a flagged failure" actually means.
- **NFR-3, for real.** `design_documents.content/version/type/requirement_set_id` are now immutable
  after insert (enforced by trigger) — before this only `status='approved'` was guarded; a project
  member could otherwise silently rewrite a document's content in place.
- **`review_gates.decided_at`** now has a CHECK constraint requiring it whenever status leaves
  `pending` (previously only `reviewer_id` was guarded, via the authority trigger).
- **Decision risk level is now editable** from the ADR Ledger, instead of being fixed forever at
  whatever the LLM assigned during generation.
- **NFRs & Risk tab** — create NFRs, cite them from decisions, manage SpikeRecords for high-risk
  decisions, record and resolve NFRConflicts. This is what makes the FR-7.1/7.2/FR-5.3 approval
  checks testable instead of theoretical — before this there was no way to create the rows those
  checks look at.
- **Dependency graph editor** — inside Diagram/Traceability, add `code_dependencies` edges (with a
  critical-path flag) that FR-4.3 blast-radius and FR-7.3/10.4 impact scoping actually read.
- **DesignChatThread (FR-1.2)** — a `design-chat` edge function + UI inside the ADR Ledger; answers
  are grounded only in the one decision and its cited requirements, nothing else.
- **Batch review actions (FR-2.2)** — select multiple pending gates in the Review Queue and
  approve/reject/request-changes as a named batch; one `review_actions` row per item, sharing a
  `batch_id`.
- **Team tab** — invite a teammate (who already has an account) by email, assign a `ReviewerRole`
  and optional `phase_scope`. Also fixed an RLS hole: `project_members` inserts previously allowed
  any authenticated user to add themself to any project; now it's gated to existing members or the
  project's own creator.
- **NFR-4** — design document content, contract specs, and threat models now render as tables/lists
  instead of raw JSON dumps. (Contract *creation* still takes a raw OpenAPI JSON blob as input — that's
  unavoidable, it's how you supply an OpenAPI spec — but every other view is structured.)
- **CI drift webhook example** — `examples/ci-drift-webhook.yml`, a worked (not wired-in) GitHub
  Actions job showing how to call `detect-drift` per PR.

**Known simplifications, worth knowing about:**
- The Team tab requires the invitee to already have a KeelRace account (looked up by exact email via
  `lookup-invitee`) — there's no email-invite-a-stranger flow
- FR-9.3's acceptance criterion ("`approved` flagged incomplete with no linked topology") doesn't map onto
  a single entity cleanly in the spec (`ArchitectureSnapshot` has no `approved` state). It's approximated
  as: any approved design document, flagged if the project has zero deployment topologies for any
  environment — close to the letter of the spec, not a literal 1:1 mapping
- Component identity is now stable via `family_key`, but skeleton *file*-to-component linking (inside one
  generation run) still matches by component name, since that's a single LLM call's own internal
  consistency rather than a cross-version matching problem
- The component reconciliation check only fires when the HLD's component set actually changed vs. the
  prior version — a project's very first HLD generation has nothing to reconcile against, so it's skipped
- The diagram layout (`DiagramView`) is a simple circular arrangement, not a proper force-directed or
  hierarchical layout — fine for a handful of components, will look cramped well past a dozen

## Rolling back

There are no maintained down-migration files — with this much trigger/function logic, tested rollback
scripts are a lot of surface area for something you'd hopefully need rarely. If you need to revert a
migration after deploying it, here's what each one actually changed, so you know what to undo:

- **0001**: the whole schema. Rolling back means dropping every table — only do this if abandoning the
  database entirely.
- **0002**: drops `approve_design_document()`, `is_authorized_reviewer()`, and the triggers that call
  them (`trg_review_gate_authority`, `trg_review_action_authority`, `trg_sync_gate_approval`,
  `trg_guard_direct_approval`, `trg_create_gate_for_design_document`). Approval reverts to a plain
  column update with no checks.
- **0003**: drops the `project_members` insert/delete policy changes and `shares_project_with()` isn't
  defined yet at this point — reverting means re-widening `project_members` inserts (re-introduces the
  RLS hole 0005 later closes; not recommended).
- **0004**: drops the `components` table and the three FK columns pointing at it
  (`code_artifacts`/`team_boundaries`/`deprecation_records.design_component_id`) — this is destructive;
  any real component data is gone.
- **0005**: re-add `profiles_select_all` (`for select using (true)`) and drop `profiles_select_self_or_shared`
  to restore global profile visibility — not recommended, this is the RLS hole that was closed.
- **0006**: `approve_design_document()` reverts to not superseding on approval at all — regenerating
  will leave prior approved versions un-superseded again (0006's whole reason for existing).
- **0007**: drop the `unique(project_id, path, generation_version)` constraint and restore
  `unique(project_id, path)` — only safe if no project has more than one skeleton generation stored.
- **0008/0009**: drop `family_key`/`reference_code`/`component_reconciliations`/`component_key_counters`
  and `nfrs.component_id` — component matching across regenerations goes back to raw name comparison,
  and NFR coverage checks go back to project-wide only.
- **0010**: `approve_design_document()` reverts to the HLD-only reconciliation check from 0008.

In general: rolling back any migration that redefines `approve_design_document()` (0002, 0006, 0008,
0010) just means re-running an earlier version of that `CREATE OR REPLACE FUNCTION` block from the
corresponding migration file — the function has no versioned history of its own, only whatever the last
migration left it as.

## Notes
- `review_actions` and `architecture_snapshots` are insert-only / immutable at the RLS
  level — there's no update policy, so even a compromised client can't rewrite history.
- `detect-drift` is meant to be called from a CI webhook (per-commit/PR), not the UI —
  wire your pipeline to POST to it with `baseline_hash`/`current_hash`/`diff`.
- Migration 0002 changes how approval works: if you already ran 0001 and clicked "Approve" directly in an
  earlier build of the Design Docs tab, those rows are unaffected, but going forward all new approvals must
  go through the Review Queue.
- Migrations 0004/0005 are breaking for pre-existing data in a few specific columns (see the deploy section
  above) — this is a fresh build, so that only matters if you've already been using an earlier version.
