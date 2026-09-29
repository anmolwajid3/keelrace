import StepStrip from './StepStrip.jsx'

export default function ProgressRail({ progress, projectId }) {
  if (!progress) return null
  const { completed, total, next } = progress

  return (
    <div className="progress-rail">
      <p className="progress-count">
        <strong>Step {next ? next.n : total} of {total}</strong>
        <span className="muted"> {next ? next.label : 'Loop complete'}</span>
        <span className="muted"> · {completed}/{total} done</span>
      </p>
      <StepStrip progress={progress} projectId={projectId} compact />
    </div>
  )
}
