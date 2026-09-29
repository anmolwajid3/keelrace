import { useParams } from 'react-router-dom'
import ProjectDashboard from '../pages/ProjectDashboard.jsx'

export default function ProjectWorkspace() {
  const { projectId } = useParams()
  return <ProjectDashboard projectId={projectId} />
}
