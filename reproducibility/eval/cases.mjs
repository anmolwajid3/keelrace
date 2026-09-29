/**
 * Evaluation cases taken from published corpora (not authored for this paper).
 * Requirement text is quoted from PURE XML [Ferrari et al., RE 2017] and
 * ArDoCo SAD dumps [Fuchß et al., ECSA 2022 workshops]. TimeArch MoodFlow
 * is retained only as a lab-continuity slice.
 */
export const KNOWLEDGE = [
  { id: 'k1', framework: 'ISO 29148', title: 'Requirements must be verifiable', body: 'A requirement should be singular, verifiable, and free of hidden design. Compound AND sentences usually hide two requirements.' },
  { id: 'k2', framework: 'ADD 3.0', title: 'Architectural drivers come before structure', body: 'Quality-attribute scenarios (stimulus, environment, response) drive decomposition. Do not invent a split until drivers are accepted.' },
  { id: 'k3', framework: 'ATAM', title: 'Utility tree and scenarios', body: 'ATAM organizes quality concerns in a utility tree. Findings are for the architect, not automatic scores.' },
  { id: 'k4', framework: 'Pattern', title: 'Modular monolith vs services', body: 'A modular monolith keeps one deployable with module boundaries; services add independent deployability at operational cost.' },
  { id: 'k5', framework: 'ADR', title: 'MADR fields', body: 'An ADR captures context, alternatives, consequences. Leave chosen_option empty until a human fills it.' },
  { id: 'k6', framework: 'Bass tactics', title: 'Availability tactics', body: 'Heartbeat, redundancy, checkpoint/rollback, isolation. Name the tactic and the quality it serves.' },
]

function R(id, ref, title, body) {
  return { id, ref_code: ref, title, body }
}

const A = (name, opt, sac) => ({ name, opt, sac })

export const CASES = [
  {
    id: 'P1',
    name: 'KeePass Password Safe',
    corpus: 'PURE',
    domain: 'encrypted password database',
    source: 'PURE XML: 2008 - keepass.xml (Ferrari et al. 2017)',
    decision_point: 'How is the composite master key bound to the encrypted database?',
    change: 'Add an optional hardware-key factor without weakening the master-password path.',
    primary_qa: 'security',
    alternatives: [
      A('Local encrypted file + composite master key', 'offline confidentiality', 'no multi-device sync'),
      A('OS credential vault adapter', 'OS keychain integration', 'portability of the .kdb file'),
      A('Cloud password service', 'sync', 'the master-password threat model in the SRS'),
    ],
    requirements: [
      R('aaaaaaaa-1111-4111-8111-000000000001', 'REQ-1', 'Install KeePass', 'KeePass must be downloaded and installed.'),
      R('aaaaaaaa-1111-4111-8111-000000000002', 'REQ-2', 'Unbounded master password', 'Master Password has no limits in length. A whole sentence can be used with more than 100 characters.'),
      R('aaaaaaaa-1111-4111-8111-000000000003', 'REQ-13', 'Repeat password match', 'Password field and repeat password field must be identical.'),
      R('aaaaaaaa-1111-4111-8111-000000000004', 'REQ-17', 'Select before delete', 'An entry must be selected to be deleted.'),
      R('aaaaaaaa-1111-4111-8111-000000000005', 'NFR-CMK', 'Composite master key', 'To open a database you must use all key sources such as password, key file and/or Windows account details that were used when the Master Key was created.'),
      R('aaaaaaaa-1111-4111-8111-000000000006', 'REQ-29', 'File format is not a specialised password DB', 'File formats are not specialized password database formats.'),
    ],
  },
  {
    id: 'P2',
    name: 'THEMAS Energy Management',
    corpus: 'PURE',
    domain: 'building HVAC control',
    source: 'PURE XML: 1998 - themas.xml (Ferrari et al. 2017)',
    decision_point: 'Where do heating/cooling unit definitions live relative to thermostat identity?',
    change: 'Add a fifth floor of thermostats without rewriting SRS-001 in place.',
    primary_qa: 'reliability',
    alternatives: [
      A('Init-file definitions + unique thermostat ids', 'matches SRS-001/002', 'file as a single point of failure'),
      A('Directory service for units', 'dynamic floors', 'Windows-only constraint in the SRS'),
      A('Cloud BMS', 'remote dashboards', 'on-prem Microsoft OS constraint'),
    ],
    requirements: [
      R('bbbbbbbb-2222-4222-8222-000000000001', 'SRS-001', 'Load H/C unit definitions', 'The THEMAS system shall control the heating and cooling units that are defined as part of the THEMAS system. The system shall read this file and the definitions shall be derived from the initialization data in the file.'),
      R('bbbbbbbb-2222-4222-8222-000000000002', 'SRS-002', 'Unique thermostat identifiers', 'Each thermostat shall have a unique identifier by which that thermostat is identified in the THEMAS system.'),
      R('bbbbbbbb-2222-4222-8222-000000000003', 'NFR-OS', 'Windows operating environment', 'The THEMAS system shall be designed to run on the Microsoft operating system; communications shall be designed to operate on this operating system.'),
      R('bbbbbbbb-2222-4222-8222-000000000004', 'NFR-TH', 'Thermostat values only', 'The thermostats shall only provide temperature values and no signal shall be available to allow direct command of the heating or cooling unit from the thermostat path described.'),
      R('bbbbbbbb-2222-4222-8222-000000000005', 'FR-CTRL', 'Control H/C units', 'The THEMAS system shall use the information contained in the initialization data file to determine which heating and cooling units are part of the THEMAS system.'),
    ],
  },
  {
    id: 'P3',
    name: 'CCTNS',
    corpus: 'PURE',
    domain: 'crime and criminal tracking (public SRS)',
    source: 'PURE XML: 0000 - cctns.xml (Ferrari et al. 2017)',
    decision_point: 'Is support reachable only in-app or also through a browser outside the application?',
    change: 'Add SMS alerts for defect-ticket status without merging help and defect modules.',
    primary_qa: 'usability',
    alternatives: [
      A('In-app help plus browser support portal', 'matches dual-access req', 'two UIs to keep consistent'),
      A('Single in-app help only', 'one surface', 'outside-browser access requirement'),
      A('Outsourced ticketing SaaS', 'speed', 'context-sensitive help bound to every UI action'),
    ],
    requirements: [
      R('cccccccc-3333-4333-8333-000000000001', 'HELP-1', 'Context-sensitive help', 'The solution should provide detailed context-sensitive help material for all the possible actions and scenarios on all user interfaces in the application.'),
      R('cccccccc-3333-4333-8333-000000000002', 'DEF-1', 'Log defects and enhancements', 'The solution should provide an interface for the user to log any defects or enhancement requests on the application and track thereafter.'),
      R('cccccccc-3333-4333-8333-000000000003', 'DEF-2', 'Optional alerts', 'The solution should send alerts (e.g., email, SMS) to the user if the user chooses to whenever any action has been taken on the alert.'),
      R('cccccccc-3333-4333-8333-000000000004', 'DEF-3', 'Track submitted requests', 'The solution should enable the user to track the submitted defect or enhancement request.'),
      R('cccccccc-3333-4333-8333-000000000005', 'DEF-4', 'Help-desk reports', 'The solution should enable the help-desk user to view the reports on the submitted defects or enhancement requests category-wise, status-wise, and age-wise.'),
      R('cccccccc-3333-4333-8333-000000000006', 'NFR-ACC', 'Support reachable in-app and via browser', 'The support solution should be accessible to the users both from within the application and also outside the application through a browser interface.'),
    ],
  },
  {
    id: 'A1',
    name: 'TeaStore',
    corpus: 'ArDoCo',
    domain: 'microservice reference shop',
    source: 'ArDoCo teastore/text_2020/teastore.txt (Fuchß et al. 2023)',
    decision_point: 'Single registry versus independent discovery per service?',
    change: 'Replace LFU image cache with LRU without changing Auth hashing.',
    primary_qa: 'performance efficiency',
    alternatives: [
      A('Five services + one Registry', 'matches published SAD', 'registry as SPOF by design'),
      A('Per-service DNS discovery', 'no single registry', 'loses the parallel-TeaStore configuration the SAD wants'),
      A('Modular monolith shop', 'simpler ops', 'replication story of WebUI/Image/Auth/Persistence/Recommender'),
    ],
    requirements: [
      R('dddddddd-4444-4444-8444-000000000001', 'TS-1', 'Five replicatable services and one Registry', 'The TeaStore consists of 5 replicatable services and a single Registry instance.'),
      R('dddddddd-4444-4444-8444-000000000002', 'TS-2', 'WebUI uses Image Provider', 'The WebUI service retrieves images from the Image Provider. Images are not provided by the WebUI, but are retrieved from the Image Provider service instead.'),
      R('dddddddd-4444-4444-8444-000000000003', 'TS-3', 'Auth hashes passwords', 'Users are authenticated by the Auth service. Passwords are hashed using BCrypt.'),
      R('dddddddd-4444-4444-8444-000000000004', 'TS-4', 'Persistence CRUD and cache', 'The Persistence service provides access to the data persisted in the relational database back-end and features endpoints for general CRUD-Operations.'),
      R('dddddddd-4444-4444-8444-000000000005', 'TS-5', 'Registry heartbeat', 'Services missing their heartbeat for more than 10 s are assumed to be offline until the register function is called again. Every running instance of the TeaStore uses one single registry.'),
      R('dddddddd-4444-4444-8444-000000000006', 'TS-6', 'Recommender fallback', 'If the current user is unknown, a fallback algorithm based on the general item popularity is chosen. If the user is known, Slope One as item-based collaborative filtering is applied.'),
    ],
  },
  {
    id: 'A2',
    name: 'JabRef',
    corpus: 'ArDoCo',
    domain: 'desktop bibliography manager',
    source: 'ArDoCo jabref/text_2021/jabref.txt (Fuchß et al. 2023)',
    decision_point: 'How strictly are model, logic, and GUI layered?',
    change: 'Add a headless logic API for CI imports without giving GUI a model bypass.',
    primary_qa: 'maintainability',
    alternatives: [
      A('Model-centred layers, dependencies inward', 'matches published SAD', 'event bus still couples layers'),
      A('Hexagonal ports around model', 'testable adapters', 'more types than the SAD describes'),
      A('GUI owns the database', 'faster screens', 'violates "model has no dependencies to other classes"'),
    ],
    requirements: [
      R('eeeeeeee-5555-4555-8555-000000000001', 'JR-1', 'Layered architecture', 'We have been successfully transitioning from a spaghetti to a more structured architecture with the model in the center, and the logic as an intermediate layer towards the gui which is the outer shell.'),
      R('eeeeeeee-5555-4555-8555-000000000002', 'JR-2', 'Inward dependencies', 'The dependencies are only directed towards the center. The model should have no dependencies to other classes of JabRef and the logic should only depend on model classes.'),
      R('eeeeeeee-5555-4555-8555-000000000003', 'JR-3', 'Build fails on layer violations', 'We have JUnit tests to detect violations of the most crucial dependencies (between logic, model, and gui), and the build will fail automatically in these cases.'),
      R('eeeeeeee-5555-4555-8555-000000000004', 'JR-4', 'Logic is the API for GUI', 'The logic is responsible for reading/writing/importing/exporting and manipulating the model, and it is structured often as an API the gui can call and use.'),
      R('eeeeeeee-5555-4555-8555-000000000005', 'JR-5', 'Event bus from model', 'We use an event bus to publish events from the model to the other layers.'),
      R('eeeeeeee-5555-4555-8555-000000000006', 'JR-6', 'CLI and preferences utilities', 'There are additional utility packages for preferences and the cli. The cli package bundles classes that are responsible for JabRef\'s command line interface.'),
    ],
  },
  {
    id: 'A3',
    name: 'TEAMMATES',
    corpus: 'ArDoCo',
    domain: 'GAE peer-evaluation web app',
    source: 'ArDoCo teammates/text_2021/teammates.txt (Fuchß et al. 2023)',
    decision_point: 'Where does access control sit relative to Logic and GAE Datastore?',
    change: 'Add a file-download action without bypassing Action access checks.',
    primary_qa: 'security',
    alternatives: [
      A('Angular UI + REST Action + Logic + GAE Datastore', 'matches published SAD', 'GAE lock-in'),
      A('Portable Spring API', 'leave GAE', 'rewrites storage and servlets the SAD assumes'),
      A('Client talks to Datastore', 'fewer hops', 'skips Action access-rights check'),
    ],
    requirements: [
      R('ffffffff-6666-4666-8666-000000000001', 'TM-1', 'Runs on GAE', 'TEAMMATES is a Web application that runs on Google App Engine (GAE).'),
      R('ffffffff-6666-4666-8666-000000000002', 'TM-2', 'Components', 'Architecture contains UI Component, Logic Component, Storage Component, Common Component, Test Driver Component, E2E Component, Client Component.'),
      R('ffffffff-6666-4666-8666-000000000003', 'TM-3', 'REST-ful controller', 'In the UI Server the entry point for the application back end logic is designed as a REST-ful controller.'),
      R('ffffffff-6666-4666-8666-000000000004', 'TM-4', 'NoSQL storage', 'The storage layer of the application uses the persistence framework provided by GAE Datastore, a NoSQL database.'),
      R('ffffffff-6666-4666-8666-000000000005', 'TM-5', 'Action checks access', 'The Action object checks the access rights of the user. If the action is allowed, it will be performed, interacting with the Logic component as necessary.'),
      R('ffffffff-6666-4666-8666-000000000006', 'TM-6', 'Client bypasses the browser', 'The Client component can connect to the back end directly without using a Web browser. It is used for administrative purposes, e.g. migrating data to a new schema.'),
    ],
  },
  {
    id: 'T1',
    name: 'MoodFlow',
    corpus: 'TimeArch',
    domain: 'privacy-focused mobile wellbeing',
    source: 'TimeArch replication package, MoodFlow SRS (Zenodo 10.5281/zenodo.20090303)',
    decision_point: 'Where should mood entries be stored and when may they leave the device?',
    change: 'Add optional encrypted family-share of weekly mood summaries.',
    primary_qa: 'security',
    alternatives: [
      A('Modular monolith', 'offline capture and a single binary', 'independent scale of sync'),
      A('Sync sidecar', 'isolate sync failures', 'two deployables too early'),
      A('BaaS-centric', 'speed of vendor features', 'confidentiality of mood payload'),
    ],
    requirements: [
      R('11111111-1111-4111-8111-111111111101', 'FR-1', 'Capture mood entries on device', 'The application shall store each mood entry on the local device using encrypted storage.'),
      R('11111111-1111-4111-8111-111111111102', 'FR-2', 'Optional cloud sync', 'The application shall offer optional encrypted sync of entries to a user-controlled account.'),
      R('11111111-1111-4111-8111-111111111103', 'NFR-1', 'Offline availability', 'Mood capture shall succeed with no network. Sync may be deferred.'),
      R('11111111-1111-4111-8111-111111111104', 'NFR-2', 'Confidentiality of mood content', 'Mood payload shall not be readable by the sync operator at rest.'),
      R('11111111-1111-4111-8111-111111111105', 'CON-1', 'Single installable', 'The first release shall ship as one mobile binary. Independent sync scale is not a driver yet.'),
      R('11111111-1111-4111-8111-111111111106', 'FR-3', 'Export and reminders', 'The user can export a CSV and can set a daily reminder and can share a summary with a clinician.'),
    ],
  },
]
