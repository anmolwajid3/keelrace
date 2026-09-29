import { KNOWLEDGE } from './cases.mjs'

const EXTRACT = 'openai/gpt-4o-mini'
const REASON = 'anthropic/claude-sonnet-4.5'

function kn() {
  return KNOWLEDGE.map((k) => `- ${k.framework}: ${k.title}: ${k.body}`).join('\n')
}

export function promptsFor(caseRow, extras = {}) {
  const reqs = caseRow.requirements
  const reqBlock = reqs.map((r) => `${r.id} ${r.ref_code}: ${r.title}\n${r.body}`).join('\n\n')
  const reqShort = reqs.map((r) => `${r.id} ${r.ref_code}: ${r.title} — ${r.body}`).join('\n')
  const reqTitles = reqs.map((r) => `${r.ref_code}: ${r.title}`).join('\n')
  const drivers = extras.drivers ?? []
  const selected = extras.selected ?? null
  const components = extras.components ?? []

  return {
    critic: {
      model: EXTRACT,
      json: true,
      messages: [
        { role: 'system', content: 'You are a requirements critic, not an architect. You do not design systems. Output JSON only. Never mark anything approved.' },
        {
          role: 'user',
          content: `Critique these requirements using ISO/IEC/IEEE 29148 / INCOSE-style rules (singular, verifiable, no hidden design unless it is a constraint).
Knowledge:
${kn()}

Requirements:
${reqBlock}

Return JSON: { "findings": [{ "requirement_id": "uuid from list", "severity": "low"|"medium"|"high", "title": "", "body": "", "suggested_rewrite": ""|null, "confidence": "grounded"|"partial"|"ungrounded", "questions": ["..."] }] }
Only use requirement ids from the list.`,
        },
      ],
    },
    drivers: {
      model: EXTRACT,
      json: true,
      messages: [
        { role: 'system', content: 'You extract ADD-style architectural drivers. You do not choose the architecture. Output JSON only.' },
        {
          role: 'user',
          content: `From these requirements, propose architectural drivers (quality-attribute scenarios).
Each driver: quality_attribute (ISO 25010 characteristic), title, stimulus, environment, response, source_requirement_ids (uuids from the list only), confidence, questions the architect must answer because context is missing.

Knowledge:
${kn()}

Requirements:
${reqShort}

JSON: { "drivers": [{ "quality_attribute": "", "title": "", "stimulus": "", "environment": "", "response": "", "source_requirement_ids": [], "confidence": "grounded"|"partial"|"ungrounded", "questions": [] }] }
Max 8 drivers. Prefer NFRs and constraints.`,
        },
      ],
    },
    candidates: {
      model: REASON,
      json: true,
      messages: [
        { role: 'system', content: 'You propose 2 or 3 architecture candidates. You never pick the winner. Output JSON only.' },
        {
          role: 'user',
          content: `Propose exactly 3 named architecture candidates for this system. Each must list what it optimizes, what it sacrifices, 3-8 components, a mermaid flowchart with SIMPLE node ids (no spaces in ids), confidence, questions, and knowledge titles used.

Accepted drivers (authoritative if present):
${JSON.stringify(drivers, null, 2).slice(0, 6000) || '(none accepted yet — say so in questions)'}

Requirements:
${reqTitles}

Knowledge:
${kn()}

JSON: { "candidates": [{ "name": "", "summary": "", "optimizes": "", "sacrifices": "", "components": [{ "name": "", "responsibility": "" }], "mermaid": "flowchart LR\\nA[Name]-->B[Name]", "confidence": "partial", "questions": [], "knowledge_titles": [] }] }`,
        },
      ],
    },
    challenge: {
      model: REASON,
      json: true,
      messages: [
        { role: 'system', content: "You are a devil's advocate. Do not produce a new architecture. Output JSON findings only. No numeric quality scores." },
        {
          role: 'user',
          content: `Attack this baseline. Look for missed drivers, hidden coupling, single points of failure, over-engineering, NFRs with no home.

Drivers: ${JSON.stringify(drivers).slice(0, 4000)}
Baseline: ${JSON.stringify(selected || { name: 'unselected' }).slice(0, 8000)}
Knowledge: ${kn()}

JSON: { "findings": [{ "severity": "low"|"medium"|"high", "title": "", "body": "", "confidence": "partial", "questions": [] }] }
Max 10 findings.`,
        },
      ],
    },
    draft_adr: {
      model: REASON,
      json: true,
      messages: [
        { role: 'system', content: 'Draft an ADR. Leave chosen_option empty. The human must fill the decision. Output JSON.' },
        {
          role: 'user',
          content: `Decision point from the architect: ${caseRow.decision_point}

Drivers: ${JSON.stringify(drivers).slice(0, 4000)}
Requirements: ${reqs.map((r) => `${r.id} ${r.ref_code}: ${r.title}`).join('\n')}
Knowledge: ${kn()}

JSON: { "alternatives": [{ "option": "", "rejection_reason": "" }], "suggested_requirement_ids": [], "consequences": "", "confidence": "partial", "questions": [], "notes_on_missing_context": "" }
suggested_requirement_ids must be uuids from the list. Do not set a winner.`,
        },
      ],
    },
    scenarios: {
      model: REASON,
      json: true,
      messages: [
        { role: 'system', content: 'Generate ATAM/SAAM evaluation scenarios. Do not score the architecture. JSON only.' },
        {
          role: 'user',
          content: `Build a utility tree and 6-10 scenarios.
Drivers: ${JSON.stringify(drivers).slice(0, 5000)}
Requirements: ${reqs.map((r) => r.ref_code + ' ' + r.title).join('; ')}
Knowledge: ${KNOWLEDGE.map((k) => k.body).join('\n')}

JSON: { "utility_tree": [{ "quality": "", "attribute": "", "scenario": "" }], "scenarios": [{ "title": "", "stimulus": "", "environment": "", "response": "", "kind": "use"|"growth"|"exploratory", "confidence": "partial", "questions": [] }] }`,
        },
      ],
    },
    views: {
      model: EXTRACT,
      json: true,
      messages: [
        { role: 'system', content: 'Produce mermaid diagrams. Node ids [A-Za-z0-9_]+ only. JSON.' },
        {
          role: 'user',
          content: `Components: ${(components.map((c) => c.name).join(', ') || 'App, Store, Sync')}
JSON: { "views": [{ "name": "context", "mermaid": "flowchart LR\\nA[User]-->B[App]" }] }`,
        },
      ],
    },
    change_brief: {
      model: EXTRACT,
      json: true,
      messages: [
        { role: 'system', content: 'Write a short change-blast brief from the graph. Do not invent new components. JSON.' },
        {
          role: 'user',
          content: `Change: ${caseRow.change}
Requirement id: ${reqs[0].id}
Graph: ${JSON.stringify({ decisions: [], teams: [], contracts: [] }).slice(0, 8000)}
Drivers: ${JSON.stringify(drivers).slice(0, 3000)}

JSON: { "brief": "", "cannot_infer": [], "confidence": "partial" }`,
        },
      ],
    },
    generate_hld: {
      model: REASON,
      json: true,
      messages: [
        { role: 'system', content: 'You output strictly valid JSON, no markdown fences, no prose.' },
        {
          role: 'user',
          content: `You are generating a High-Level Design (HLD) from a locked, approved set of requirements.
The architect remains the authority. You fill a draft document; approval is a later human gate.
Requirements:
${reqs.map((r) => `- ${r.ref_code}: ${r.title}\n  ${r.body}`).join('\n')}

No candidate is selected. Propose a structure from the requirements and accepted drivers only. Do not claim it was chosen.

Return ONLY valid JSON with this exact shape:
{
  "hld": {
    "summary": string,
    "components": [
      { "name": string, "description": string, "needs_detail": boolean, "matched_family_key": string | null }
    ]
  },
  "decisions": [
    {
      "decision_point": string,
      "chosen_option": string,
      "alternatives_considered": [{ "option": string, "rejection_reason": string }],
      "driving_requirement_ref_codes": string[],
      "risk_level": "low" | "medium" | "high"
    }
  ],
  "llds": [
    {
      "component_name": string,
      "content": { "summary": string, "interfaces": string[], "data_model": string }
    }
  ]
}`,
        },
      ],
    },
    ask: {
      model: REASON,
      json: true,
      messages: [
        {
          role: 'system',
          content: `You answer questions about THIS project's recorded architecture only.
If the record does not contain the answer, say so. Do not invent components, requirements, or decisions.
Cite ref_codes or decision points you used. Output JSON { "answer": "", "citations": ["FR-1", ...], "confidence": "grounded"|"partial"|"ungrounded", "missing": [] }`,
        },
        {
          role: 'user',
          content: `Record:
${JSON.stringify({
  requirements: reqs.map((r) => ({ id: r.id, ref_code: r.ref_code, title: r.title, body: r.body })),
  drivers,
  components,
  decisions: [],
  contracts: [],
  files: [],
}).slice(0, 14000)}

Knowledge (for vocabulary only, not facts about this system):
${KNOWLEDGE.map((k) => k.title).join(', ')}

Question: Which quality attributes are first-class in the locked requirements?`,
        },
      ],
    },
  }
}
