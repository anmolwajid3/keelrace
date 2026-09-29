export default function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  danger = false,
  confirmDisabled = false,
  children,
  onCancel,
  onConfirm,
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        {body && <p className="muted">{body}</p>}
        {children}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? 'danger' : ''} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
