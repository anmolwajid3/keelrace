import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { PROJECT_NAV, navItemStatus } from '../lib/nav.js'
import { findDemoProject, isDemoProject, ensureDemoProject } from '../lib/demoProject.js'
import { projectNavMeta } from '../lib/projectLabel.js'
import { IconFolder, IconLamp, IconFlask, IconShield, IconGear, IconGuide, IconPdf } from './Icons.jsx'
import { useAuth } from '../hooks/useAuth.jsx'
import { useToast } from '../hooks/useToast.jsx'

export default function WorkspaceNav({
  projectId,
  progress,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  walkBusy,
  onStartWalkthrough,
}) {
  const { user } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const loc = useLocation()
  const asideGroup = PROJECT_NAV.find((g) => g.aside)
  const onAsidePage = !!projectId && (asideGroup?.items ?? []).some((n) => loc.pathname.endsWith(`/${n.to}`))
  const [openAside, setOpenAside] = useState(false)
  const [projects, setProjects] = useState([])
  const [openProjects, setOpenProjects] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!user?.id) return
    supabase.from('projects').select('id, name, created_at, archived_at, kind').order('created_at', { ascending: false })
      .then(async ({ data, error }) => {
        let rows = data
        if (error && /kind|schema cache|column/i.test(error.message)) {
          const retry = await supabase.from('projects').select('id, name, created_at, archived_at').order('created_at', { ascending: false })
          rows = retry.data
        }
        const list = (rows ?? []).filter((p) => !p.archived_at)
        setProjects(list.filter((p) => !isDemoProject(p)))
      })
    findDemoProject(user.id).catch(() => null)
  }, [user?.id, projectId])

  useEffect(() => {
    if (onAsidePage) setOpenAside(true)
  }, [onAsidePage])

  const q = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    const list = q
      ? projects.filter((p) => {
        const m = projectNavMeta(p)
        return m.title.toLowerCase().includes(q) || m.full.toLowerCase().includes(q) || (m.kind || '').includes(q)
      })
      : projects
    return list
  }, [projects, q])

  async function openDemo() {
    if (demoBusy) return
    setDemoBusy(true)
    try {
      const row = await ensureDemoProject(user.id)
      nav(`/projects/${row.id}`)
      onNavigate?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setDemoBusy(false)
    }
  }

  return (
    <div className={`workspace-nav${collapsed ? ' collapsed' : ''}${projectId ? ' with-project' : ''}`}>
      <div className="nav-rail">
        {projectId && (
          <button type="button" className="rail-toggle" onClick={onToggleCollapsed} title={collapsed ? 'Show names' : 'Icons only'}>
            {collapsed ? '›' : '‹'}
          </button>
        )}
        <div className="nav-group">
          <div className="nav-group-label">{collapsed ? '' : 'Workspace'}</div>
          <NavLink to="/projects" end className="nav-item" title="Projects" onClick={onNavigate}>
            <span className="nav-icon"><IconFolder /></span>
            <span className="nav-item-label">Projects</span>
          </NavLink>
          {projectId && !collapsed && (
            <button
              type="button"
              className={`nav-item nav-disclosure${openProjects ? ' open' : ''}`}
              title="Switch project"
              onClick={() => setOpenProjects((v) => !v)}
            >
              <span className="nav-item-label">{openProjects ? '▾' : '▸'} Switch project</span>
            </button>
          )}
          {projectId && !collapsed && openProjects && (
            <div className="nav-flyout">
              <NavLink to="/projects?new=1" className="nav-sub" onClick={onNavigate}>New project</NavLink>
              {visible.length > 6 && (
                <input
                  className="nav-search"
                  type="search"
                  placeholder="Find a project…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <div className="nav-flyout-label nav-switch-label">Open one</div>
              <div className="project-switch">
                {visible.map((p) => {
                  const m = projectNavMeta(p)
                  const current = p.id === projectId
                  return (
                    <NavLink
                      key={p.id}
                      to={`/projects/${p.id}`}
                      className={`nav-sub nav-project${current ? ' active' : ''}`}
                      title={m.full}
                      onClick={onNavigate}
                    >
                      <span className="nav-sub-title">{m.title}</span>
                    </NavLink>
                  )
                })}
              </div>
              {!visible.length && <p className="nav-empty">{q ? 'No match' : 'None yet'}</p>}
            </div>
          )}
          <button type="button" className="nav-item" title="Demo project" onClick={openDemo} disabled={demoBusy}>
            <span className="nav-icon"><IconLamp /></span>
            <span className="nav-item-label">{demoBusy ? 'Opening…' : 'Demo project'}</span>
          </button>
          <button type="button" className="nav-item" title="How this works" onClick={() => { onStartWalkthrough?.(); onNavigate?.() }} disabled={walkBusy}>
            <span className="nav-icon"><IconGuide /></span>
            <span className="nav-item-label">{walkBusy ? 'Opening…' : 'How this works'}</span>
          </button>
          <a
            className="nav-item"
            href="/keelrace-user-guide.pdf"
            target="_blank"
            rel="noopener noreferrer"
            title="User guide (PDF, new tab)"
            onClick={onNavigate}
          >
            <span className="nav-icon"><IconPdf /></span>
            <span className="nav-item-label">User guide</span>
          </a>
          <NavLink to="/agent-test" className="nav-item" title="Agent test" onClick={onNavigate}>
            <span className="nav-icon"><IconFlask /></span>
            <span className="nav-item-label">Agent test</span>
          </NavLink>
        </div>
        <div className="nav-group">
          <NavLink to="/admin" className="nav-item" title="Admin" onClick={onNavigate}>
            <span className="nav-icon"><IconShield /></span>
            <span className="nav-item-label">Admin</span>
          </NavLink>
          <NavLink to="/settings" className="nav-item" title="Settings" onClick={onNavigate}>
            <span className="nav-icon"><IconGear /></span>
            <span className="nav-item-label">Settings</span>
          </NavLink>
        </div>
      </div>

      {projectId && (
        <div className="nav-steps">
          {PROJECT_NAV.map((group) => (
            <div key={group.label} className={`nav-group${group.aside ? ' nav-group-aside' : ''}`}>
              {group.aside ? (
                <button
                  type="button"
                  className={`nav-item nav-disclosure${openAside ? ' open' : ''}`}
                  onClick={() => setOpenAside((v) => !v)}
                >
                  <span className="nav-item-label">{openAside ? '▾' : '▸'} {group.label}</span>
                </button>
              ) : (
                <div className="nav-group-label">{group.label}</div>
              )}
              {(!group.aside || openAside) && (
                <div className={group.aside ? 'nav-aside' : undefined}>
                  {group.blurb && <p className="nav-aside-blurb">{group.blurb}</p>}
                  {group.items.map((n) => {
                    const st = navItemStatus(n, progress)
                    return (
                      <NavLink
                        key={n.to || 'index'}
                        to={`/projects/${projectId}${n.to ? `/${n.to}` : ''}`}
                        end={n.end}
                        data-tour={n.to || 'requirements'}
                        className={({ isActive }) => `nav-item nav-${st.kind}${isActive ? ' active' : ''}`}
                        onClick={onNavigate}
                        title={n.use || st.title}
                      >
                        {!group.aside && <span className={`nav-dot nav-dot-${st.kind}`} aria-hidden="true" />}
                        <span className="nav-item-label">
                          {n.label}
                          {n.use && <span className="nav-item-use">{n.use}</span>}
                        </span>
                      </NavLink>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
