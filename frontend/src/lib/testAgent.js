import { supabase } from './supabase'

const KEY = 'keelrace.test_agent'

export async function loadTestAgentAllowed(userId) {
  const { data, error } = await supabase.from('profiles').select('test_agent').eq('id', userId).maybeSingle()
  if (!error && data && Object.prototype.hasOwnProperty.call(data, 'test_agent')) {
    return !!data.test_agent
  }
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export async function saveTestAgentAllowed(userId, allowed) {
  try {
    localStorage.setItem(KEY, allowed ? '1' : '0')
  } catch { /* ignore */ }
  const { error } = await supabase.from('profiles').update({ test_agent: allowed }).eq('id', userId)
  if (error && /test_agent|schema cache|column/i.test(error.message)) return null
  return error
}
