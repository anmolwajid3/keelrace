import { humanizeError } from '../lib/errors.js'

export default function ErrorBanner({ error }) {
  if (!error) return null
  const { headline, detail } = humanizeError(error)
  return (
    <div className="error-banner" role="alert">
      <p>{headline}</p>
      {detail && (
        <details>
          <summary>Technical detail</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </div>
  )
}
