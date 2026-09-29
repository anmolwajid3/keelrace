/**
 * Standing-rule check shared by edge functions and scripts/influence-audit.mjs.
 * The database function classify_option in migration 0026 mirrors this.
 * A result of "replaces" is never inferred from prose. A person records it
 * by pointing at a new decision.
 */

const MECHANISMS = [
  "ttl",
  "time-to-live",
  "time to live",
  "expire",
  "expiry",
  "timer",
  "delete the row",
  "deletes the row",
  "deletes the hold",
  "delete the hold",
]

const HOLDS_PHRASES = [
  "same terminal event",
  "the rule already",
  "already allowed",
  "allowed ending",
  "uses the existing ending",
]

const LOCAL_CONSTRAINT = [
  /local-only/i,
  /local only/i,
  /no network/i,
  /without a network/i,
  /single machine/i,
  /on one machine/i,
  /offline only/i,
  /must stay local/i,
]

const LOCAL_SECRET = [
  /master key/i,
  /master password/i,
  /encrypted database/i,
  /\.kdb\b/i,
]

const NETWORKED = [
  /\bcloud\b/i,
  /\bsaas\b/i,
  /network service/i,
  /remote service/i,
  /api gateway/i,
  /\bmicroservices?\b/i,
  /kubernetes/i,
]

export function splitEndings(endsWhen) {
  return String(endsWhen || "")
    .split(/\s*,\s*|\s+or\s+/i)
    .map((s) => s.trim().replace(/^or\s+/i, "").trim())
    .filter((s) => s.length >= 3)
}

export function classifyOption(allowedEndings, claimedEnding, optionText) {
  const allowed = (allowedEndings || []).map((s) => String(s).trim()).filter(Boolean)
  const opt = String(optionText || "")
  const claimed = String(claimedEnding || "").trim()
  const haystack = `${opt}\n${claimed}`.toLowerCase()

  for (const mech of MECHANISMS) {
    if (!haystack.includes(mech)) continue
    const allowedHasIt = allowed.some((a) => a.toLowerCase().includes(mech))
    if (!allowedHasIt) {
      return {
        result: "breaks",
        reason: `This option introduces "${mech}", which is not an allowed way for the rule to end.`,
      }
    }
  }

  const text = `${opt} ${claimed}`.trim()
  if (!text) {
    return {
      result: "breaks",
      reason: "This option does not name which allowed ending it uses.",
    }
  }

  const lower = text.toLowerCase()
  if (HOLDS_PHRASES.some((p) => lower.includes(p))) {
    return {
      result: "holds",
      reason: "This option uses an ending the rule already allows.",
    }
  }

  for (const ending of allowed) {
    const e = ending.toLowerCase()
    if (e.length >= 8 && (lower.includes(e) || (claimed.length >= 8 && e.includes(claimed.toLowerCase())))) {
      return {
        result: "holds",
        reason: `This option ends the rule in a way the rule already allows: ${ending}.`,
      }
    }
  }

  return {
    result: "breaks",
    reason: claimed
      ? `This option ends the rule by "${claimed}", which is not an allowed ending.`
      : "This option does not name which allowed ending it uses.",
  }
}

/** Prose alone cannot replace a rule. The caller must already have a new decision. */
export function replacementVerdict(reason) {
  const why = String(reason || "").trim()
  if (!why) {
    return {
      result: "breaks",
      reason: "Replacing a rule requires a written reason and a new decision.",
    }
  }
  return { result: "replaces", reason: why }
}

export function constraintVerdict(requirementTexts, candidateText) {
  const req = (requirementTexts || []).join("\n")
  const cand = String(candidateText || "")
  const local = LOCAL_CONSTRAINT.some((r) => r.test(req))
  const secret = LOCAL_SECRET.some((r) => r.test(req))
  const networked = NETWORKED.some((r) => r.test(cand))
  if ((local || secret) && networked) {
    return {
      verdict: "breaks",
      reason: local
        ? "This candidate adds a network or cloud service while a stated constraint keeps the system local."
        : "This candidate moves the store to a cloud or network service while the requirements bind a master key to the local database.",
    }
  }
  return { verdict: "clear", reason: null }
}

export function influenceShare(rows) {
  const list = rows || []
  if (!list.length) return null
  const unchanged = list.filter((r) => r.origin === "model_unchanged").length
  return unchanged / list.length
}
