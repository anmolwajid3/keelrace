# KeelRace reproducibility (ICSA artefact)

Reviewers need **no API key and no GPU**.

```bash
node scripts/reproduce.mjs --smoke    # one pass + coverage + ablations
node scripts/reproduce.mjs            # N=10 variance (CV = 0 under replay)
```

Validation layers written to `reproducibility/_out/results.json`:
- **L1** lifecycle completeness
- **L2** authority ablations (misuse paths must be rejected)
- **L3** coverage metrics (citation / driver / trade-off rates)
- **L4** integrity checks + replay CV

Default `LLM_MODE` for hosted functions is `auto`: hit `supabase/functions/_shared/llm-cassette.json`, else call OpenRouter if `OPENROUTER_API_KEY` is set. `LLM_MODE=replay` never leaves the cassette.

`--record` is maintainer-only (`OPENROUTER_API_KEY`). It overwrites cassette entries from live model calls.

Outputs: `reproducibility/_out/results.json`, `variance.json`. Baseline: `reproducibility/baseline/results.json`.
