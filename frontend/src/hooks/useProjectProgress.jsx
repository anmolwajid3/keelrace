import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { loadProjectProgress } from '../lib/progress.js'

const Ctx = createContext(null)

export function ProjectProgressProvider({ projectId, children }) {
  const [progress, setProgress] = useState(null)
  const reload = useCallback(async () => {
    if (!projectId) return setProgress(null)
    try {
      setProgress(await loadProjectProgress(supabase, projectId))
    } catch {
      setProgress(null)
    }
  }, [projectId])

  useEffect(() => { reload() }, [reload])

  return <Ctx.Provider value={{ progress, reload }}>{children}</Ctx.Provider>
}

export function useProjectProgress() {
  return useContext(Ctx) ?? { progress: null, reload: () => {} }
}
