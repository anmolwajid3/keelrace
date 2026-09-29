import { Link } from 'react-router-dom'
import { useProjectProgress } from '../hooks/useProjectProgress.jsx'
import StepStrip from './StepStrip.jsx'

export default function LoopSteps({ projectId }) {
  const { progress } = useProjectProgress()
  if (!progress) return null
  const remaining = (progress.remaining ?? []).slice(0, 4)
  return (
    <div className="loop-steps-wrap">
      <p className="muted" style={{ marginTop: 0 }}>
        <strong>Step {progress.next ? progress.next.n : progress.total} of {progress.total}</strong>
        {remaining.length
          ? ` — still needed: ${remaining.map((s) => `${s.n}. ${s.label}`).join(', ')}.`
          : ' — loop complete. Preview and export the package.'}
        {' '}<Link to={`/projects/${projectId}/package`}>Open package</Link>
      </p>
      <StepStrip progress={progress} projectId={projectId} compact />
    </div>
  )
}
