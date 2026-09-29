import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth.jsx'
import Landing from './pages/Landing.jsx'
import Login from './pages/Login.jsx'
import ProjectList from './pages/ProjectList.jsx'
import ProjectWorkspace from './pages/ProjectWorkspace.jsx'
import SettingsPage from './pages/Settings.jsx'
import AdminPage from './pages/Admin.jsx'
import AgentTestPage from './pages/AgentTest.jsx'
import AppShell from './components/AppShell.jsx'

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="dash-main"><div className="skeleton" /><div className="skeleton" /></div>
  if (!user) return <Navigate to="/login" replace />
  return children
}

function GuestOnly({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="dash-main"><div className="skeleton" /></div>
  if (user) return <Navigate to="/projects" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route
        element={(
          <Protected>
            <AppShell />
          </Protected>
        )}
      >
        <Route path="/projects" element={<ProjectList />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/agent-test" element={<AgentTestPage />} />
        <Route path="/projects/:projectId/*" element={<ProjectWorkspace />} />
      </Route>
    </Routes>
  )
}
