import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import AgentTestPanel from '../components/AgentTestPanel.jsx'
import { isDemoProject } from '../lib/demoProject.js'

export default function AgentTestPage() {
  const [projects, setProjects] = useState([])
  useEffect(() => {
    supabase.from('projects').select('id, name, created_at, archived_at, kind').order('created_at', { ascending: false })
      .then(({ data, error }) => {
        const rows = (data ?? []).filter((p) => !p.archived_at && !isDemoProject(p))
        if (error && /kind|schema cache|column/i.test(error.message)) {
          supabase.from('projects').select('id, name, created_at, archived_at').order('created_at', { ascending: false })
            .then(({ data: fallback }) => setProjects((fallback ?? []).filter((p) => !p.archived_at && !isDemoProject(p))))
          return
        }
        setProjects(rows)
      })
  }, [])
  return (
    <div className="dash-main">
      <AgentTestPanel projects={projects} />
    </div>
  )
}
