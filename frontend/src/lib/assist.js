import { callFunction } from './supabase'

export function callAssist(action, body) {
  return callFunction('architect-assist', { action, ...body })
}

export function confidenceBadge(c) {
  if (c === 'grounded') return { cls: 'ok', label: 'grounded' }
  if (c === 'ungrounded') return { cls: 'warn', label: 'ungrounded' }
  return { cls: 'muted', label: c || 'partial' }
}
