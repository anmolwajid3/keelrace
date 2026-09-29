import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useTheme } from '../hooks/useTheme.jsx'
import { IconMoon, IconSun } from './Icons.jsx'
import ProfileMenu from './ProfileMenu.jsx'
import Walkthrough from './Walkthrough.jsx'
import WorkspaceNav from './WorkspaceNav.jsx'
import { ProjectProgressProvider, useProjectProgress } from '../hooks/useProjectProgress.jsx'
import { useAuth } from '../hooks/useAuth.jsx'
import { ensureDemoProject } from '../lib/demoProject.js'
import { useToast } from '../hooks/useToast.jsx'

export default function AppShell() {
  const loc = useLocation()
  const projectMatch = loc.pathname.match(/^\/projects\/([^/]+)/)
  const projectId = projectMatch?.[1] ?? null

  return (
    <ProjectProgressProvider projectId={projectId} key={projectId || 'none'}>
      <AppShellInner projectId={projectId} />
    </ProjectProgressProvider>
  )
}

function AppShellInner({ projectId }) {
  const loc = useLocation()
  const nav = useNavigate()
  const toast = useToast()
  const { user } = useAuth()
  const { theme, toggle } = useTheme()
  const [navOpen, setNavOpen] = useState(false)
  const [walk, setWalk] = useState(false)
  const [demoId, setDemoId] = useState(null)
  const [walkBusy, setWalkBusy] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const { progress } = useProjectProgress()

  async function startWalkthrough() {
    if (!user?.id || walkBusy) return
    setWalkBusy(true)
    try {
      const demo = await ensureDemoProject(user.id)
      setDemoId(demo.id)
      if (loc.pathname !== `/projects/${demo.id}`) nav(`/projects/${demo.id}`)
      setWalk(true)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setWalkBusy(false)
    }
  }

  const closeNav = () => setNavOpen(false)

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="icon-btn sidebar-toggle" aria-label="Open navigation" onClick={() => setNavOpen((o) => !o)}>☰</button>
          <Link to="/projects" className="brand">
            <span className="brand-mark">K</span>
            KeelRace
          </Link>
        </div>
        <div className="topbar-right">
          <button type="button" className="icon-btn" onClick={toggle} aria-label="Toggle theme" title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
            {theme === 'light' ? <IconMoon /> : <IconSun />}
          </button>
          <ProfileMenu />
        </div>
      </header>

      <div className="layout">
        {navOpen && <button type="button" className="nav-scrim sidebar-toggle" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
        <aside className={`sidebar ${navOpen ? 'open' : ''} ${projectId ? 'has-project' : ''} ${railCollapsed && projectId ? 'rail-collapsed' : ''}`}>
          <WorkspaceNav
            projectId={projectId}
            progress={progress}
            collapsed={Boolean(projectId) && railCollapsed}
            onToggleCollapsed={() => setRailCollapsed((v) => !v)}
            onNavigate={closeNav}
            walkBusy={walkBusy}
            onStartWalkthrough={startWalkthrough}
          />
        </aside>
        <div className="workspace">
          <Outlet />
        </div>
      </div>
      {walk && <Walkthrough demoProjectId={demoId} onClose={() => setWalk(false)} />}
    </div>
  )
}
