import type { JSX } from 'react'

export function LoadFailed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="d-error load-failed" role="alert">
      <p><strong>{what}</strong> could not be read just now. Nothing is lost; try again.</p>
      <button className="btn small" onClick={onRetry}>
        Try again
      </button>
      {error ? <details className="d-disclose"><summary>Technical bits</summary><p>{error}</p></details> : null}
    </div>
  )
}

export function Loading({ text }: { text: string }): JSX.Element {
  return (
    <p className="d-lede load-pending" role="status" aria-busy="true">
      {text}
    </p>
  )
}
