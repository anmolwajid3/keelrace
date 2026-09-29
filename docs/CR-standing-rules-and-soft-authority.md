# Change request: standing rules and soft authority

| Field | Value |
|---|---|
| Door | 1 — stakeholder-requested change |
| Action | add |
| Status | implemented in the product (phase 6 participant study still needs people) |
| Target requirement | none yet — this adds behavior the current requirements do not name |

## What is wrong today

Two separate holes, both left open by TimeArch and BRIDGE.

**Standing rules.** An approved decision is stored as text. The next change is checked for paperwork: a link exists, a quality requirement is cited, a reviewer clicked approve. Nothing asks whether the new change still keeps a rule the project already accepted. Drift trusts three yes/no flags sent by the caller. Triage counts documents.

**Soft authority.** The approve button is locked to a human. The model still writes the menu. It proposes exactly three candidates, names them, and fills “optimizes” and “sacrifices.” The challenger attacks only the candidate someone already selected, and those findings do not block approval. The decision draft leaves the winner blank, then writes the other options and the reasons to reject them. The high-level design is generated from the selected candidate. A human signature can sit on a design the model already decided.

TimeArch treats a stage gate as a human decision. BRIDGE treats a proposed decision record as waiting for an architect, and its study never included one. Neither measures options that were never offered, loaded wording, order, unequal critique, or how much of the approved design was written by the model.

## What this change adds

One change, two parts. Part A is the rule check. Part B is an honest account of who wrote the design. The existing approve lock stays. It is the groundwork: the model cannot press approve. This change covers what that lock cannot catch.

### Part A — a standing rule, and three results

When a decision is approved, store the rule in a form a later check can use:

- one sentence stating what must stay true
- the parts of the system it covers (component, API, table, config, code artifact)
- how the rule is allowed to end

When a later change, candidate, or code diff touches those parts, each option gets one result:

- **Holds.** The change still does what the rule says. It can go on.
- **Breaks.** The change gives a second way for the rule to fail. Approval stops until the change is rewritten.
- **Replaces.** A person records a new decision that retires the old rule and says why. The old rule stays in the ledger as replaced.

Run the check on every option, including options added by a later rewrite. One good linked option does not pass the document while another option breaks the rule.

Use it on both doors. A design change is checked before the new design can be approved. A code change is checked against the same rules: if the diff breaks a rule, that is drift, whether or not anyone filed a design change.

Worked example. The accepted rule is: a hold ends only when the reservation is confirmed, rejected, or hits the timeout stored on that row. It covers the reservation table and the transfer API.

- A sweeper that writes that same terminal event **holds**.
- A 15-minute timer that deletes the hold with no terminal event **breaks**.
- A person who wants the timer anyway files a new decision that retires the old rule. That is **replaces**.

### Part B — show who wrote the design, and mark a bad menu

On the review screen, for each piece of the approved design, show one origin:

- copied from the model
- edited from the model
- written by the architect

Before anyone picks a candidate:

- mark a candidate that breaks a standing rule or a stated constraint, and still show it (hiding it would be another way to steer)
- run the challenger on every candidate, and store that critique on the candidate

The KeePass case is the constraint mark: a threat model that says the system stays on one machine, and a candidate that adds a network service, shown as a break rather than as a normal option.

### Study mode, not the everyday screen

These are for the evaluation. They are not the default product.

- shuffled order and neutral labels (“Option 1”), so a study can see whether order or wording changes a person’s pick
- an optional box where the architect writes a preferred direction before the candidates appear; record whether they used it
- an “AI influence share” number computed from the origins above, reported in the paper as who typed the text, not as a score to push down

A correct design copied from the model is still correct. The number to judge the product by is constraint breaks and missing options that would have held, not how often the architect retyped a sentence.

## What stays as it is

- `approve_design_document()` still refuses a direct status update. The new check is an additional reason that function can refuse.
- Models still may not set `design_documents.status` or `requirement_sets.status`.
- Cassette replay stays for the reproducibility script. Live models are used for the bias audit, not for the replay baseline.

## Development plan

Each phase is usable on its own. Do them in order. A later phase assumes the tables from the earlier one.

### Phase 1 — store the rule

**Build**

- Migration `0026_standing_rules.sql`.
- Table `standing_rules`: `decision_rationale_id`, `rule_text`, `ends_when`, `covers` (jsonb: component ids, artifact ids, contract paths, config keys), `status` (`in_force` or `replaced`), `replaced_by` (nullable, points at the decision that retired it).
- Approving a decision that has no rule sentence and no covers does not invent one. The architect confirms both. The model may draft them into `assist_adr_drafts`; the human copies them onto the rule.
- ADR Ledger UI: rule sentence, what it covers, how it ends, next to the existing decision text.

**Done when**

- An approved decision can carry an in-force rule.
- Replacing it requires a second decision id. The first row stays, with status `replaced`.

**Touches**

- `decision_rationales` (read; do not overload `chosen_option` to hold the rule)
- `supabase/functions/architect-assist/index.ts` `runDraftAdr`
- `frontend/src/components/assist/AdrAssist.jsx` and the ADR Ledger screen

### Phase 2 — one result per option

**Build**

- Table `rule_verdicts`: what was checked (`change_request`, `signal`, `candidate`, `adr_alternative`, `drift`), the rule id, the result (`holds`, `breaks`, `replaces`), the reason sentence, and which option it refers to.
- A check that loads every in-force rule whose `covers` overlap the change, and writes one verdict per option.
- `approve_design_document()` refuses while any verdict on that document is `breaks` and no replacement decision is linked.
- The review screen shows the rule, the result, and the sentence. It does not show a quality score.

**Done when**

- The reservation example produces holds, breaks, and replaces as three stored rows.
- A document with one holding option and one breaking option cannot be approved.
- After a rewrite adds a new option, that option has its own verdict. Old verdicts are kept.

**Touches**

- `approve_design_document()` in the latest migration that defines it (`0025_qa_workshop.sql` is the current body)
- Review Queue UI

### Phase 3 — both doors, and drift that reads the rule

**Build**

- Door 1: `reconverge-change` and `apply-requirement-change` write verdicts before a new design can be resolved. A `breaks` result stops resolve.
- Door 2: `detect-drift` loads rules that cover the artifact. A diff that breaks one is `architectural_drift`, with the verdict id stored on the drift event. The three caller booleans stop being the classification.
- Triage names the rules touched, instead of only counting documents and risk flags.

**Done when**

- A design change and a code change against the same rule produce the same three results.
- A diff that deletes a hold with no terminal event is drift even when no change request exists.

**Touches**

- `supabase/functions/detect-drift/index.ts`
- `supabase/functions/triage-change/index.ts`
- `supabase/functions/reconverge-change/index.ts`
- `supabase/functions/apply-requirement-change/index.ts`
- `frontend/src/components/ChangesTab.jsx`

### Phase 4 — the menu, the critique, and the origin

**Build**

- On each `architecture_candidates` row: generation index, a constraint verdict, and a link to any standing rule it breaks. The candidate stays visible.
- `runChallenge` runs once per candidate at generation time. Findings keep `candidate_id` on `target`. Today the challenger runs only against the selected candidate or the latest HLD.
- Table `design_provenance`: design document id, element key (component family key or decision id), origin (`model_unchanged`, `model_edited`, `architect`), source candidate id. `generate-design-docs` writes a row when it copies a selected candidate into an HLD. An architect edit flips `model_unchanged` to `model_edited`. Text the architect adds with no candidate source is `architect`.
- Review screen lists origin per element. Candidates that break a rule show the break sentence on the card.

**Done when**

- Three candidates each have their own challenger findings before anyone selects one.
- A local-only constraint marks a networked candidate as a break, and the candidate is still on screen.
- An approved HLD shows which components were copied, edited, or written by the architect.

**Touches**

- `runCandidates` and `runChallenge` in `supabase/functions/architect-assist/index.ts`
- `supabase/functions/generate-design-docs/index.ts`
- `frontend/src/components/assist/DesignAssist.jsx`
- `frontend/src/components/assist/ArchitectAssistTab.jsx`

### Phase 5 — study mode

**Build**

- A project flag `study_mode`. When on: candidates render in shuffled order with labels “Option 1”, “Option 2”, “Option 3”, and the optimize/sacrifice lines stay collapsed until opened. When off, the normal names and order are shown.
- Optional pre-commitment: a text field stored on the project before candidates are fetched. Empty is allowed. The row records whether it was filled.
- A report query, not a gate: influence share = share of provenance rows that are `model_unchanged`; constraint-break rate; critique length per generation index. Written into `reproducibility/_out/` when the audit script runs. It does not block approve.

**Done when**

- The same three candidates can be shown two ways, and the stored generation index is unchanged by the shuffle.
- The report emits the three numbers from stored rows. Live model calls are separate from cassette replay.

**Touches**

- `frontend` candidate list
- `scripts/reproduce.mjs` only to add an audit output path; the replay baseline stays cassette-only

### Phase 6 — the evaluation

Do this after Phases 1–5 store the rows the questions need. Cassette replay still proves the gates reject misuse. Live models answer the new questions.

| Question | What it uses | What it must not claim |
|---|---|---|
| How does a model steer a decision without approving it? | Taxonomy: omission, framing, order, unequal critique, driver choice. Bias audit on the PURE and ArDoCo documents already under `reproducibility/external/`. Count constraint breaks (network candidate for a local-only system) and whether the first candidate is criticized more softly than the others. | That a person was steered. That needs the last row. |
| How much of an approved design came from the model? | `design_provenance` shares. | That a lower share is a better architecture. |
| Do the new checks reduce constraint breaks and missing holding options? | With the marks and the per-option verdicts, against the same documents without them. | That “the architect typed more” is success. |
| Do people pick differently when order or wording changes? | Study mode, with participants. | Anything, if participants are not available. Say the audit showed a biased menu, and stop. |

## Order of work

1. Phase 1, then 2. The rule and the three results are the product change.
2. Phase 3. Both doors use the same results, and drift stops trusting caller flags.
3. Phase 4. The menu and the origin trace. This is the soft-authority work that belongs in the product.
4. Phase 5, then 6. Study mode and the paper’s measurements.

## One-line statement

The model cannot press approve. It can still decide, by writing the menu and by letting a new change drop a rule the project already accepted. This change records the rule, gives every later option a result, and shows which part of the approved design the model wrote.
