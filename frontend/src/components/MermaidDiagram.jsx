import { useEffect, useId, useState } from 'react'
import { useTheme } from '../hooks/useTheme.jsx'

let configuredTheme = null

async function draw(source, id, theme) {
  const mermaid = (await import('mermaid')).default
  if (configuredTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'neutral',
      fontFamily: 'inherit',
    })
    configuredTheme = theme
  }
  const { svg } = await mermaid.render(id, source)
  return svg
}

export default function MermaidDiagram({ source, valid = true }) {
  const { theme } = useTheme()
  const reactId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState('')
  const [err, setErr] = useState(null)

  useEffect(() => {
    const text = String(source || '').trim()
    if (!text || valid === false) {
      setSvg('')
      setErr(null)
      return undefined
    }
    let cancelled = false
    const id = `kr${reactId}${Math.random().toString(36).slice(2, 8)}`
    draw(text, id, theme)
      .then((next) => {
        if (!cancelled) {
          setSvg(next)
          setErr(null)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setSvg('')
          setErr(e?.message || 'Could not draw this diagram.')
        }
      })
    return () => { cancelled = true }
  }, [source, valid, theme, reactId])

  const text = String(source || '').trim()
  if (!text) return <p className="muted">Nothing to draw.</p>
  if (valid === false || err) {
    return (
      <div>
        <p className="badge danger">
          {valid === false
            ? 'This diagram failed the syntax check, so it stays as text.'
            : 'Could not draw this diagram. The source is below.'}
        </p>
        <pre className="code-view">{text}</pre>
      </div>
    )
  }
  return (
    <div className="mermaid-frame" aria-label="Diagram">
      {!svg && <p className="muted">Drawing…</p>}
      {svg && <div dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  )
}
