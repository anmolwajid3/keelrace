export const WALKTHROUGH_STEPS = [
  {
    id: 'loop',
    title: 'LampCheck is the example, not your job',
    body: 'This is a desk lamp: press on, a countdown, double-press to extend, watchdog if the driver lies after timeout. Offline only. How this works opens this filled project. Your own work stays on Projects. The first pass is seven pages, in the order on the left. You finish a page, then leave it.',
    tour: 'requirements',
  },
  {
    id: 'reqs',
    title: '1. Requirements — lock, then generate',
    body: 'FR-1 on/off, FR-2 auto-off, FR-3 safety cut, FR-4 extend, CON-1 no network. The set is locked. Generation refuses a draft. On this same page I generated the system map: Switch, Timer, Watchdog, LampDriver. Critic and driver cards sit here too. I dismissed “CON-1 is compound” and rejected a cloud split the SRS never asked for. Those cards propose. They do not approve.',
    tour: 'requirements',
  },
  {
    id: 'nfrs',
    title: '2. Quality rules',
    body: 'NFR-S (the bulb must not stay powered) and NFR-A (works offline) live on NFRs & Risk. Review refuses the map until each rule has a home on a decision, or you record an override. Assist does not tick that box.',
    tour: 'nfrs',
  },
  {
    id: 'design',
    title: '3. Design Docs — attach the rules',
    body: 'Read the system map and attach the quality rules to it. Candidate splits on this page are proposals: I kept four modules on one MCU and discarded a cloud timer. Selecting a candidate is not approval. Prototype and skeleton are not on this page. They come after Review.',
    tour: 'design',
  },
  {
    id: 'review',
    title: '4. Review — a person makes it official',
    body: 'Approve the system map, then the component designs, before you leave. Request changes needs a comment. Reject throws this generate out. A model cannot set this status. If an option breaks a standing rule, Approve stops until the option is rewritten or a person replaces the rule and writes why.',
    tour: 'review',
  },
  {
    id: 'trace',
    title: '5. Diagram — prototype, skeleton, zip',
    body: 'Prototype and Skeleton are created here, from the approved map. switch.ts, timer.ts, watchdog.ts, and driver.ts are linked by component id. The filename is not the identity. Download zip saves this generation as a folder.',
    tour: 'traceability',
  },
  {
    id: 'snap',
    title: '6. Snapshot',
    body: 'Capture freezes the structure you have now, so a later change can be compared with this moment.',
    tour: 'snapshots',
  },
  {
    id: 'pkg',
    title: '7. Package — what you would defend',
    body: 'The export leads with the rules still in force and the rules that were retired, with the reason. Then the settled questions: the answer that won, and the answers that were turned down. Language, database product, and hosting count only if they appear there. This is the brief you take into a review.',
    tour: 'package',
  },
  {
    id: 'library',
    title: 'Library — open it when the question shows up',
    body: 'Library is not an eighth pass. ADR Ledger is where a confirmed decision becomes a standing rule: one sentence, the only way it may end, and what it covers. On LampCheck, Timer owns remaining time. Drift & Health is for after a file changes: still allowed, or it breaks a rule. Changes & Signals is how a locked set grows — a new version, not a silent edit. Evidence map answers “why does this component exist?” from the record.',
    tour: 'adr',
  },
]
