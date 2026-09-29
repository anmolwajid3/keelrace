export const LLM_PROVIDERS = [
  { id: 'grok', label: 'Grok', hint: 'xAI — default for generation today' },
  { id: 'claude', label: 'Claude', hint: 'Anthropic — when the server key is configured' },
  { id: 'openai', label: 'OpenAI', hint: 'GPT models via OpenAI-compatible API' },
]

const KEY = 'keelrace.settings.llm'

export function loadLlmSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { provider: 'grok', model: '', ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { provider: 'grok', model: '' }
}

export function saveLlmSettings(next) {
  localStorage.setItem(KEY, JSON.stringify(next))
}
