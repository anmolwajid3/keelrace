import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { WALKTHROUGH_STEPS } from '../lib/walkthrough.js'

export default function Walkthrough({ demoProjectId, onClose }) {
  const nav = useNavigate()
  const [i, setI] = useState(0)
  const step = WALKTHROUGH_STEPS[i]
  const last = i === WALKTHROUGH_STEPS.length - 1

  function go(pathTour) {
    if (!demoProjectId) return
    nav(pathTour === 'requirements' ? `/projects/${demoProjectId}` : `/projects/${demoProjectId}/${pathTour}`)
  }

  useEffect(() => {
    go(WALKTHROUGH_STEPS[0].tour)
  }, [demoProjectId])

  function finish() {
    localStorage.setItem('keelrace.walkthrough.seen', '1')
    onClose()
  }

  function next() {
    const n = i + 1
    if (n < WALKTHROUGH_STEPS.length) {
      go(WALKTHROUGH_STEPS[n].tour)
      setI(n)
    } else finish()
  }

  function back() {
    const n = i - 1
    if (n >= 0) {
      go(WALKTHROUGH_STEPS[n].tour)
      setI(n)
    }
  }

  return (
    <div className="walk-overlay" role="dialog" aria-labelledby="walk-title">
      <div className="walk-card">
        <p className="kicker">How KeelRace works · {i + 1}/{WALKTHROUGH_STEPS.length}</p>
        <h2 id="walk-title">{step.title}</h2>
        {!demoProjectId && <p className="muted">Opening the LampCheck example…</p>}
        <p>{step.body}</p>
        <div className="row wrap">
          <button type="button" className="secondary" disabled={i === 0} onClick={back}>Back</button>
          {last
            ? <button type="button" onClick={finish}>Start working</button>
            : <button type="button" onClick={next}>Next</button>}
          <button type="button" className="ghost" onClick={finish}>Skip</button>
        </div>
      </div>
    </div>
  )
}
