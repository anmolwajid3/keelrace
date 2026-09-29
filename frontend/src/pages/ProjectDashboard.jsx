import { useEffect, useState } from 'react'
import { Link, Routes, Route, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ProgressRail from '../components/ProgressRail.jsx'
import { useProjectProgress } from '../hooks/useProjectProgress.jsx'
import RequirementsTab from '../components/RequirementsTab.jsx'
import DesignDocsTab from '../components/DesignDocsTab.jsx'
import ReviewQueueTab from '../components/ReviewQueueTab.jsx'
import AdrLedgerTab from '../components/AdrLedgerTab.jsx'
import DriftHealthTab from '../components/DriftHealthTab.jsx'
import ChangesTab from '../components/ChangesTab.jsx'
import ContractsTab from '../components/ContractsTab.jsx'
import TraceabilityTab from '../components/TraceabilityTab.jsx'
import SnapshotsTab from '../components/SnapshotsTab.jsx'
import TeamBoundariesTab from '../components/TeamBoundariesTab.jsx'
import DebtBacklogTab from '../components/DebtBacklogTab.jsx'
import GovernanceTab from '../components/GovernanceTab.jsx'
import NfrsRiskTab from '../components/NfrsRiskTab.jsx'
import TeamTab from '../components/TeamTab.jsx'
import AuditTab from '../components/AuditTab.jsx'
import PackageTab from '../components/PackageTab.jsx'
import MapVerifyTab from '../components/MapVerifyTab.jsx'
import ArchitectAssistTab from '../components/assist/ArchitectAssistTab.jsx'
import { isDemoProject } from '../lib/demoProject.js'

export default function ProjectDashboard({ projectId }) {
  const [project, setProject] = useState(null)
  const { progress, reload } = useProjectProgress()
  const loc = useLocation()

  useEffect(() => {
    let cancelled = false
    supabase.from('projects').select('id, name, archived_at, kind').eq('id', projectId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error && /kind|schema cache|column/i.test(error.message)) {
          supabase.from('projects').select('id, name, archived_at').eq('id', projectId).maybeSingle()
            .then(({ data: row }) => { if (!cancelled) setProject(row) })
          return
        }
        setProject(data)
      })
    reload()
    return () => { cancelled = true }
  }, [projectId, loc.pathname, reload])

  const next = progress?.next
  const cue = next
    ? { text: `Step ${next.n} of ${progress.total} — ${next.label}. ${next.remain}`, to: next.to }
    : { text: `Step ${progress?.total ?? 10} of ${progress?.total ?? 10} — loop complete. Preview and export the package.`, to: 'package' }

  return (
    <>
      <header className="workspace-header">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project?.name ?? '…'}
          </h1>
          {isDemoProject(project) && <span className="badge">example · LampCheck</span>}
          {project?.archived_at && <span className="badge muted">archived</span>}
        </div>
        <ProgressRail progress={progress} projectId={projectId} />
      </header>
      {cue && (
        <div className="cue-bar">
          <span>{cue.text}</span>
          <Link to={next ? `/projects/${projectId}${next.to ? `/${next.to}` : ''}` : `/projects/${projectId}/package`}>
            {next ? `Go to step ${next.n}` : 'Open package'}
          </Link>
        </div>
      )}
      <div className="main">
        <Routes>
          <Route index element={<RequirementsTab projectId={projectId} />} />
          <Route path="design" element={<DesignDocsTab projectId={projectId} />} />
          <Route path="review" element={<ReviewQueueTab projectId={projectId} />} />
          <Route path="nfrs" element={<NfrsRiskTab projectId={projectId} />} />
          <Route path="adr" element={<AdrLedgerTab projectId={projectId} />} />
          <Route path="package" element={<PackageTab projectId={projectId} />} />
          <Route path="map" element={<MapVerifyTab projectId={projectId} />} />
          <Route path="health" element={<DriftHealthTab projectId={projectId} />} />
          <Route path="changes" element={<ChangesTab projectId={projectId} />} />
          <Route path="contracts" element={<ContractsTab projectId={projectId} />} />
          <Route path="traceability" element={<TraceabilityTab projectId={projectId} />} />
          <Route path="snapshots" element={<SnapshotsTab projectId={projectId} />} />
          <Route path="teams" element={<TeamBoundariesTab projectId={projectId} />} />
          <Route path="debt" element={<DebtBacklogTab projectId={projectId} />} />
          <Route path="governance" element={<GovernanceTab projectId={projectId} />} />
          <Route path="team" element={<TeamTab projectId={projectId} />} />
          <Route path="audit" element={<AuditTab projectId={projectId} />} />
          <Route path="assist" element={<ArchitectAssistTab projectId={projectId} />} />
        </Routes>
      </div>
    </>
  )
}

