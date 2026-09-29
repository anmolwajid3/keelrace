import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import RequirementsAssist from './RequirementsAssist.jsx'
import DesignAssist from './DesignAssist.jsx'
import AdrAssist from './AdrAssist.jsx'
import { AskArchitecture } from './AskAssist.jsx'
import { WorkshopPanel } from './WorkshopPanel.jsx'
import ChangeAssist from './ChangeAssist.jsx'
import MapAssist from './MapAssist.jsx'
import KnowledgeLibrary from './KnowledgeLibrary.jsx'

export default function ArchitectAssistTab({ projectId }) {
  const [setId, setSetId] = useState(null)
  const [docs, setDocs] = useState([])
  const [requirements, setRequirements] = useState([])
  const [artifacts, setArtifacts] = useState([])

  useEffect(() => {
    supabase.from('requirement_sets').select('id').eq('project_id', projectId).order('version', { ascending: false }).limit(1)
      .then(({ data }) => setSetId(data?.[0]?.id ?? null))
    supabase.from('design_documents').select('id, type, version, status, requirement_sets!inner(project_id)').eq('requirement_sets.project_id', projectId)
      .then(({ data }) => setDocs(data ?? []))
    supabase.from('requirements').select('id, ref_code, title, requirement_sets!inner(project_id)').eq('requirement_sets.project_id', projectId)
      .then(({ data }) => setRequirements(data ?? []))
    supabase.from('code_artifacts').select('id, path, type, design_component_id').eq('project_id', projectId).eq('type', 'file')
      .then(({ data }) => setArtifacts(data ?? []))
  }, [projectId])

  return (
    <div>
      <h1>Architect assist</h1>
      <p className="muted">
        Helpers propose. You accept, reject, or ignore. Nothing here auto-approves a document or locks a requirement set.
        Official HLD still comes from Generate on Requirements and Approve in Review Queue.
      </p>
      <p className="muted">
        Also embedded on <Link to={`/projects/${projectId}`}>Requirements</Link>,{' '}
        <Link to={`/projects/${projectId}/design`}>Design</Link>,{' '}
        <Link to={`/projects/${projectId}/adr`}>ADR</Link>,{' '}
        <Link to={`/projects/${projectId}/map`}>Evidence map</Link>,{' '}
        <Link to={`/projects/${projectId}/changes`}>Changes</Link>, and{' '}
        <Link to={`/projects/${projectId}/traceability`}>Traceability</Link>.
      </p>
      <KnowledgeLibrary />
      <RequirementsAssist projectId={projectId} requirementSetId={setId} />
      <DesignAssist projectId={projectId} requirementSetId={setId} />
      <AdrAssist projectId={projectId} docs={docs} requirements={requirements} />
      <AskArchitecture projectId={projectId} />
      <WorkshopPanel projectId={projectId} />
      <ChangeAssist projectId={projectId} />
      <MapAssist projectId={projectId} artifacts={artifacts} />
    </div>
  )
}
