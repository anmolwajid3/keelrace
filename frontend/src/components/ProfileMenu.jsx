import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.jsx'
import { loadTestAgentAllowed } from '../lib/testAgent.js'
import { avatarHue, avatarImageUrl, initialsFromUser } from '../lib/avatar.js'

export default function ProfileMenu() {
  const { user, signOut } = useAuth()
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const [testAgent, setTestAgent] = useState(false)
  const wrap = useRef(null)
  const initials = initialsFromUser(user)
  const photo = !imgFailed && avatarImageUrl(user)
  const hue = avatarHue(user?.email || user?.id)

  useEffect(() => { setOpen(false) }, [loc.pathname])
  useEffect(() => {
    loadTestAgentAllowed(user.id).then(setTestAgent)
  }, [user.id, loc.pathname])
  useEffect(() => {
    function onDoc(e) {
      if (!wrap.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="profile-wrap" ref={wrap}>
      <button
        type="button"
        className="profile-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={user?.email}
      >
        {photo ? (
          <img className="profile-avatar-img" src={photo} alt="" onError={() => setImgFailed(true)} />
        ) : (
          <span className="profile-avatar" aria-hidden="true" style={{ background: `hsl(${hue} 48% 38%)`, color: '#fff' }}>
            {initials}
          </span>
        )}
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-menu-head">
            {photo ? (
              <img className="profile-avatar-img lg" src={photo} alt="" />
            ) : (
              <span className="profile-avatar lg" style={{ background: `hsl(${hue} 48% 38%)`, color: '#fff' }}>{initials}</span>
            )}
            <div>
              <div className="profile-email">{user?.email}</div>
            </div>
          </div>
          <Link to="/admin" role="menuitem" onClick={() => setOpen(false)}>Admin</Link>
          {testAgent && <Link to="/agent-test" role="menuitem" onClick={() => setOpen(false)}>Agent test</Link>}
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)}>Profile settings</Link>
          <button type="button" role="menuitem" onClick={() => signOut()}>Log out</button>
        </div>
      )}
    </div>
  )
}
