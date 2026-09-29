import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.jsx'
import { useTheme } from '../hooks/useTheme.jsx'
import { IconMoon, IconSun } from '../components/Icons.jsx'

const CHECKS = [
  'Seven pages, each finished before you leave it',
  'Assist proposes — it never approves',
  'A confirmed decision becomes a standing rule',
  'The next change holds, breaks, or replaces that rule',
]

const SNAKE = [
  {
    phase: '1 — Write it',
    color: '#c9a227',
    steps: [
      { title: 'Lock & generate', body: 'Requirements, then the system map' },
      { title: 'Quality rules', body: 'What the product must still satisfy' },
      { title: 'Attach them', body: 'Design Docs, once' },
    ],
  },
  {
    phase: '2 — You decide',
    color: '#14b8a6',
    steps: [
      { title: 'Review', body: 'The map, then the components' },
      { title: 'Standing rule', body: 'Holds, breaks, or replaces' },
      { title: 'Diagram', body: 'Prototype, skeleton, and a zip' },
    ],
  },
  {
    phase: '3 — Hand it over',
    color: '#4f46e5',
    steps: [
      { title: 'Snapshot', body: 'Freeze the structure you have now' },
      { title: 'Package', body: 'Rules in force, and the ones you retired' },
      { title: 'Library', body: 'Open it when a later question shows up' },
    ],
  },
]

function ApproveGate({ label, above = false }) {
  return (
    <div className={`snake-gate${above ? ' above' : ''}`}>
      <span className="snake-gate-diamond" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 2l8 10-8 10L4 12z" fill="currentColor" /><path d="M8.2 12.2l2.4 2.4 5-5.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span>{label}</span>
    </div>
  )
}

function SnakeRoadmap() {
  const y1 = 95
  const y2 = 260
  const y3 = 425
  const xL = 110
  const xR = 860
  const r = (y2 - y1) / 2

  return (
    <div className="snake" role="list" aria-label="Seven pages along one loop">
      <svg className="snake-svg" viewBox="0 0 1000 520" fill="none" aria-hidden="true">
        <path
          d={`M ${xL} ${y1} H ${xR} A ${r} ${r} 0 0 1 ${xR} ${y2}`}
          stroke={SNAKE[0].color}
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d={`M ${xR} ${y2} H ${xL} A ${r} ${r} 0 0 0 ${xL} ${y3}`}
          stroke={SNAKE[1].color}
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d={`M ${xL} ${y3} H 820`}
          stroke={SNAKE[2].color}
          strokeWidth="7"
          strokeLinecap="round"
        />
      </svg>

      <div className="snake-start">Start</div>

      <p className="snake-phase" style={{ left: '18%', top: '6%', color: SNAKE[0].color }}>{SNAKE[0].phase}</p>
      {SNAKE[0].steps.map((step, i) => (
        <div key={step.title} className="snake-node below" role="listitem" style={{ left: `${22 + i * 20}%`, top: '18.2%' }}>
          <i className="snake-dot" style={{ borderColor: SNAKE[0].color }} />
          <strong>{step.title}</strong>
          <span>{step.body}</span>
        </div>
      ))}
      <div className="snake-gate-wrap" style={{ left: '82%', top: '12%' }}><ApproveGate label="You approve" /></div>

      <p className="snake-phase" style={{ right: '18%', top: '37%', color: SNAKE[1].color, textAlign: 'right' }}>{SNAKE[1].phase}</p>
      {SNAKE[1].steps.map((step, i) => (
        <div key={step.title} className="snake-node below" role="listitem" style={{ left: `${70 - i * 20}%`, top: '50%' }}>
          <i className="snake-dot" style={{ borderColor: SNAKE[1].color }} />
          <strong>{step.title}</strong>
          <span>{step.body}</span>
        </div>
      ))}
      <div className="snake-gate-wrap" style={{ left: '11%', top: '46%' }}><ApproveGate label="In force" above /></div>

      <p className="snake-phase" style={{ left: '18%', top: '69%', color: SNAKE[2].color }}>{SNAKE[2].phase}</p>
      {SNAKE[2].steps.map((step, i) => (
        <div key={step.title} className="snake-node below" role="listitem" style={{ left: `${22 + i * 18}%`, top: '81.8%' }}>
          <i className="snake-dot" style={{ borderColor: SNAKE[2].color }} />
          <strong>{step.title}</strong>
          <span>{step.body}</span>
        </div>
      ))}

      <div className="snake-shipped">The brief</div>
    </div>
  )
}

const LESSONS = [
  {
    label: 'Assist · propose only',
    title: 'Specialised roles that stop at the gate',
    body: 'Criticism, architectural drivers, candidate comparison, evaluation prep, and ADR drafting land as provisional findings. The architect accepts or dismisses — assist has no write path into approve.',
    mock: 'assist',
  },
  {
    label: 'Workshop · not a score',
    title: 'Scenarios, walks, and sensitivity points',
    body: 'Build evaluation scenarios, walk them against components, and record trade-off points. KeelRace never invents a fitness number. Unwalked in-boundary scenarios block approval.',
    mock: 'workshop',
    flip: true,
  },
  {
    label: 'Authority · human only',
    title: 'Review that refuses rubber stamps',
    body: 'Reviewers see the document, NFR citations, and workshop state. High risk you confirm needs a completed spike. Model-assigned risk does not force one. Easy approve-all without reading is not the goal.',
    mock: 'review',
  },
  {
    label: 'Rule · after you confirm',
    title: 'A decision that later work must hold',
    body: 'You confirm one sentence, the only way it may end, and what it covers. A later option or file change holds, breaks, or replaces that rule. Breaks stops approval. Replaces needs a new decision and a written reason. The old rule stays in the ledger.',
    mock: 'ledger',
    flip: true,
  },
]

const SHIPPED = [
  { title: 'Requirements', sub: 'Lock the set, then generate the map' },
  { title: 'Review', sub: 'A person approves the map and the components' },
  { title: 'Diagram', sub: 'Prototype, skeleton, and a zip of the stubs' },
  { title: 'Package', sub: 'Rules in force, retired rules, settled questions' },
]

function CheckIcon() {
  return (
    <svg className="m-check" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="currentColor" opacity="0.15" />
      <path d="M5.5 10.2l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HeroMock() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 4), 2200)
    return () => clearInterval(id)
  }, [])
  const rows = [
    { label: 'Requirements', state: 'Locked', tone: 'ok' },
    { label: 'System map', state: tick > 0 ? 'Cited' : 'Draft', tone: tick > 0 ? 'accent' : 'muted' },
    { label: 'Review', state: tick > 1 ? 'Human only' : 'Waiting', tone: tick > 1 ? 'ok' : 'warn' },
    { label: 'Standing rule', state: tick > 2 ? 'In force' : 'Unconfirmed', tone: tick > 2 ? 'ok' : 'muted' },
  ]
  return (
    <div className="m-hero-mock" aria-hidden="true">
      <div className="m-mock-chrome">
        <span /><span /><span />
        <em>keelrace · review gate</em>
      </div>
      <div className="m-mock-body">
        <div className="m-mock-side">
          <strong>LampCheck</strong>
          <span>Governed loop</span>
          {['Requirements', 'Design Docs', 'Review', 'Diagram', 'Package'].map((t, i) => (
            <div key={t} className={`m-mock-nav ${i === Math.min(tick, 4) ? 'on' : ''}`}>{t}</div>
          ))}
        </div>
        <div className="m-mock-main">
          <p className="m-mock-kicker">Authority check</p>
          <h3>Nothing becomes official until a person owns it</h3>
          <ul>
            {rows.map((r) => (
              <li key={r.label}>
                <span>{r.label}</span>
                <span className={`badge ${r.tone}`}>{r.state}</span>
              </li>
            ))}
          </ul>
          <div className="m-mock-actions">
            <span className="ghost">Request changes</span>
            <span className="m-mock-btn">Approve (human)</span>
          </div>
        </div>
      </div>
      <div className="m-float m-float-a">
        <strong>Propose-only</strong>
        <span>Assist cannot call approve</span>
      </div>
      <div className="m-float m-float-b">
        <strong>In force</strong>
        <span>Local encrypted file</span>
      </div>
    </div>
  )
}

function FeatureMock({ kind }) {
  if (kind === 'assist') {
    return (
      <div className="m-feat-mock">
        <p className="m-mock-kicker">Architect assist</p>
        <div className="m-feat-row"><span>Driver extraction</span><span className="badge muted">Provisional</span></div>
        <div className="m-feat-row"><span>Candidate compare</span><span className="badge muted">Provisional</span></div>
        <div className="m-feat-row"><span>ADR draft</span><span className="badge warn">Chosen option empty</span></div>
        <div className="m-feat-row"><span>Approval write</span><span className="badge danger">No path</span></div>
      </div>
    )
  }
  if (kind === 'workshop') {
    return (
      <div className="m-feat-mock">
        <p className="m-mock-kicker">Evaluation workshop</p>
        <div className="m-feat-row"><span>SCN-01 cold start</span><span className="badge ok">Walked</span></div>
        <div className="m-feat-row"><span>SCN-02 failover</span><span className="badge ok">Walked</span></div>
        <div className="m-feat-row"><span>Sensitivity · latency vs cost</span><span className="badge accent">Point</span></div>
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>No quality score invented.</p>
      </div>
    )
  }
  if (kind === 'review') {
    return (
      <div className="m-feat-mock">
        <p className="m-mock-kicker">Review queue</p>
        <div className="m-feat-row"><span>NFR citations</span><span className="badge ok">Covered</span></div>
        <div className="m-feat-row"><span>In-boundary walks</span><span className="badge ok">Present</span></div>
        <div className="m-feat-row"><span>Human risk spike</span><span className="badge warn">Required</span></div>
        <div className="m-feat-row"><span>Model risk guess</span><span className="badge muted">No spike forced</span></div>
      </div>
    )
  }
  return (
    <div className="m-feat-mock">
      <p className="m-mock-kicker">Standing rule</p>
      <div className="m-feat-row"><span>Local encrypted file</span><span className="badge ok">Holds</span></div>
      <div className="m-feat-row"><span>15-minute timer deletes the row</span><span className="badge danger">Breaks</span></div>
      <div className="m-feat-row"><span>New decision, written reason</span><span className="badge warn">Replaces</span></div>
      <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>The retired rule stays in the ledger.</p>
    </div>
  )
}

export default function Landing() {
  const { user } = useAuth()
  const { theme, toggle } = useTheme()
  const nav = useNavigate()
  const appHref = user ? '/projects' : '/login'

  return (
    <div className="marketing dp">
      <header className="dp-top">
        <nav className="m-nav dp-nav">
          <Link to="/" className="brand m-brand-light">
            <span className="brand-mark">K</span>
            KeelRace
          </Link>
          <div className="m-nav-links">
            <a href="#path">How it works</a>
            <a href="#lessons">Capabilities</a>
            <a href="#shipped">Workspace</a>
          </div>
          <div className="m-nav-actions">
            <button type="button" className="icon-btn m-icon-light" onClick={toggle} aria-label="Toggle theme">
              {theme === 'light' ? <IconMoon /> : <IconSun />}
            </button>
            <button type="button" className="ghost m-ghost-light" onClick={() => nav(appHref)}>
              {user ? 'Workspace' : 'Sign in'}
            </button>
            <button type="button" className="m-cta-btn" onClick={() => nav(appHref)}>
              {user ? 'Open projects' : 'Start free'}
            </button>
          </div>
        </nav>

        <div className="dp-hero">
          <div className="dp-hero-copy">
            <p className="dp-eyebrow">Governed architecture workplace</p>
            <h1>KeelRace</h1>
            <p className="dp-tag">
              Seven pages, once each. You lock the requirements, approve the map, and leave with a package:
              the rules still in force, the rules you retired, and the questions you settled.
            </p>
            <ul className="dp-checks">
              {CHECKS.map((c) => (
                <li key={c}><CheckIcon />{c}</li>
              ))}
            </ul>
            <div className="dp-hero-cta">
              <button type="button" className="m-cta-btn m-cta-lg" onClick={() => nav(appHref)}>
                {user ? 'Continue to projects' : 'Start your first project'}
              </button>
              <button
                type="button"
                className="ghost m-ghost-light"
                onClick={() => document.getElementById('path')?.scrollIntoView({ behavior: 'smooth' })}
              >
                See the loop
              </button>
            </div>
          </div>
          <HeroMock />
        </div>
      </header>

      <div className="dp-trust" aria-label="Product pillars">
        <span>Seven pages, once each</span>
        <span>Propose-only assist</span>
        <span>Human approval</span>
        <span>Standing rules</span>
        <span>Package you can defend</span>
      </div>

      <section className="m-section dp-section" id="path">
        <p className="kicker">How the loop works</p>
        <h2>One pass, then the brief you would defend</h2>
        <p className="muted m-section-lede">
          Finish the page you are on, then follow the curve. Assist may propose along the way. It never approves.
        </p>
        <SnakeRoadmap />
      </section>

      <section className="dp-band" id="lessons">
        <div className="m-section dp-section">
          <p className="kicker">Capabilities</p>
          <h2>What the system does now</h2>
          <p className="muted m-section-lede">
            A model can draft a document and stop. KeelRace keeps the decision you accepted and checks the next change against it.
          </p>
          <div className="dp-lessons">
            {LESSONS.map((lesson) => (
              <article key={lesson.title} className={`dp-lesson ${lesson.flip ? 'flip' : ''}`}>
                <div className="dp-lesson-copy">
                  <p className="dp-label">{lesson.label}</p>
                  <h3>{lesson.title}</h3>
                  <p className="muted">{lesson.body}</p>
                </div>
                <FeatureMock kind={lesson.mock} />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="m-section dp-section" id="shipped">
        <p className="kicker">In the workspace</p>
        <h2>Surfaces you work in today</h2>
        <div className="dp-shipped">
          {SHIPPED.map((s) => (
            <article key={s.title}>
              <h3>{s.title}</h3>
              <p className="muted">{s.sub}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="m-section dp-section dp-faq">
        <h2>Why not stop when the document exists?</h2>
        <p className="muted">
          A generated design, and a proposed decision left unsigned, both end when the file is written.
          KeelRace records the sentence you confirmed, the only way that sentence may end, and the parts of the system it covers.
          The next option or the next file change holds, breaks, or replaces that rule. Approve is a person. The package is the list you would defend.
        </p>
      </section>

      <section className="dp-bottom-cta">
        <h2>Start with a locked requirement set</h2>
        <p className="muted">Import an SRS, generate the map, approve it yourself, then export the rules you are willing to stand behind.</p>
        <button type="button" className="m-cta-btn m-cta-lg" onClick={() => nav(appHref)}>
          {user ? 'Open workspace' : 'Create your first project'}
        </button>
      </section>

      <footer className="m-footer">
        <span>KeelRace</span>
        <span className="faint">Propose freely. Approve only as a person.</span>
      </footer>
    </div>
  )
}
