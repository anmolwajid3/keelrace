const RULES = [
  { test: /row-level security|permission denied|42501/i, headline: "You don't have permission to do this. Check your team role." },
  { test: /JWT expired|invalid JWT|not authenticated|Auth session missing/i, headline: 'Your session expired. Sign in again.' },
  { test: /duplicate key|unique constraint|23505/i, headline: 'A record with this identifier already exists.' },
  { test: /locked requirement|cannot be edited|requirement_sets_lock|draft-only/i, headline: 'This requirement set is locked. Open a Change Request or copy it to a new draft.' },
  { test: /column .*archived_at|Could not find the ['\"]archived_at['\"] column/i, headline: 'This workspace is missing a database update (archive/delete). Apply migration 0013, then retry.' },
  { test: /evaluation_scenarios|evaluation_walks|evaluation_utility_nodes|evaluation_points|evaluation_outcomes|risk_set_by/i, headline: 'Apply migration 0025 (QA workshop tables), then retry. Walks are not a quality score.' },
  { test: /violates foreign key|23503/i, headline: 'This item is still referenced elsewhere, so it cannot be removed.' },
  { test: /null value in column|23502/i, headline: 'A required field is missing.' },
  { test: /in-boundary scenario/i, headline: 'Walk in-workshop scenarios through the HLD (or mark them out of the workshop) before Approve. This is not a quality score.' },
  { test: /architect-rated high-risk/i, headline: 'A high-risk rating you set needs a completed spike. Model-guessed risk does not block Approve.' },
  { test: /PGRST|postgres|sql state|function .* does not exist/i, headline: 'Something went wrong while saving. See technical detail.' },
  { test: /Invalid login credentials/i, headline: 'Email or password is incorrect.' },
  { test: /User already registered/i, headline: 'An account with that email already exists. Sign in instead.' },
]

export function humanizeError(error) {
  const raw = typeof error === 'string' ? error : error?.message ?? String(error ?? 'Something went wrong')
  const match = RULES.find((r) => r.test.test(raw))
  if (match) return { headline: match.headline, detail: raw }
  return { headline: raw, detail: null }
}
