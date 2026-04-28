import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import {
  applyPermissionsSliceToConfig,
  readPermissionsSlice,
  type ChatEntry,
  type DebugLogEvent,
  type GroupRow,
  type PersonaPayload,
  type StatusPayload,
  type TalkyConfig,
  type UnauthorizedCandidate,
} from '@/types/api'

type TalkyConsoleState = {
  status: StatusPayload | null
  config: TalkyConfig | null
  /** Working copy for Allowlists / permissions; synced from server when not dirty. */
  configDraft: TalkyConfig | null
  configDirty: boolean
  unauthorized: UnauthorizedCandidate[]
  groups: GroupRow[]
  chats: Record<string, ChatEntry[]>
  editingPersona: PersonaPayload
  personaDirty: boolean
  debugEvents: DebugLogEvent[]
  refresh: () => Promise<void>
  setEditingPersona: (next: PersonaPayload) => void
  savePersona: () => Promise<void>
  patchConfigDraft: (
    patch: Partial<TalkyConfig> | ((prev: TalkyConfig) => TalkyConfig),
  ) => void
  saveConfigDraft: () => Promise<void>
  resetConfigDraft: () => void
  resolveUnauthorized: (
    jid: string,
    action: 'allow' | 'discard',
    listType: 'direct' | 'group',
  ) => Promise<void>
  sessionAction: (action: 'relink' | 'repair') => Promise<void>
}

const TalkyConsoleContext = createContext<TalkyConsoleState | null>(null)

const POLL_MS = 3000
/** After relink, poll status faster while Baileys emits a new QR. */
const RELINK_FAST_POLL_MS = 1000
const RELINK_FAST_POLL_DURATION_MS = 60_000

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function TalkyConsoleProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [config, setConfig] = useState<TalkyConfig | null>(null)
  const [unauthorized, setUnauthorized] = useState<UnauthorizedCandidate[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [chats, setChats] = useState<Record<string, ChatEntry[]>>({})
  const [editingPersona, setEditingPersonaState] = useState<PersonaPayload>({
    soul: '',
    communicationRules: '',
    recentMemory: '',
  })
  const [personaDirty, setPersonaDirty] = useState(false)
  const [debugEvents, setDebugEvents] = useState<DebugLogEvent[]>([])
  const personaInitialized = useRef(false)
  const configDirtyRef = useRef(false)
  const [configDraft, setConfigDraft] = useState<TalkyConfig | null>(null)
  const [configDirty, setConfigDirty] = useState(false)
  const fetchOkRef = useRef(true)

  const fetchData = useCallback(async () => {
    try {
      const [st, cfg, unauth, grp, per, ch, dbg] = await Promise.all([
        fetchJson<StatusPayload>('/api/status'),
        fetchJson<TalkyConfig>('/api/config'),
        fetchJson<UnauthorizedCandidate[]>('/api/unauthorized'),
        fetchJson<GroupRow[]>('/api/groups'),
        fetchJson<PersonaPayload>('/api/persona'),
        fetchJson<Record<string, ChatEntry[]>>('/api/chats'),
        fetchJson<DebugLogEvent[]>('/api/logs/events?limit=300'),
      ])
      setStatus(st)
      setConfig(cfg)
      setConfigDraft((prev) => {
        if (configDirtyRef.current && prev) return prev
        return structuredClone(cfg)
      })
      setUnauthorized(unauth)
      setGroups(grp)
      setChats(ch ?? {})
      setDebugEvents(Array.isArray(dbg) ? dbg : [])
      if (!personaInitialized.current) {
        setEditingPersonaState(per)
        personaInitialized.current = true
      } else if (!personaDirty) {
        setEditingPersonaState(per)
      }
      if (!fetchOkRef.current) {
        fetchOkRef.current = true
        toast.success('Talky API reachable again')
      }
    } catch (e) {
      console.error('[Talky UI] fetch', e)
      if (fetchOkRef.current) {
        fetchOkRef.current = false
        toast.error(
          'Cannot reach Talky API (check the bot is running and Vite proxy matches WEB_UI_PORT).',
          { duration: 8000 },
        )
      }
    }
  }, [personaDirty])

  useEffect(() => {
    let alive = true
    const boot = window.setTimeout(() => {
      if (alive) void fetchData()
    }, 0)
    const id = window.setInterval(() => {
      if (alive) void fetchData()
    }, POLL_MS)
    return () => {
      alive = false
      window.clearTimeout(boot)
      window.clearInterval(id)
    }
  }, [fetchData])

  const setEditingPersona = useCallback((next: PersonaPayload) => {
    setEditingPersonaState(next)
    setPersonaDirty(true)
  }, [])

  const savePersona = useCallback(async () => {
    await fetchJson('/api/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingPersona),
    })
    toast.success('Persona saved')
    setPersonaDirty(false)
    void fetchData()
  }, [editingPersona, fetchData])

  const resolveUnauthorized = useCallback(
    async (
      jid: string,
      action: 'allow' | 'discard',
      listType: 'direct' | 'group',
    ) => {
      await fetchJson('/api/unauthorized/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid, action, listType }),
      })
      toast.success(action === 'allow' ? 'Allowed' : 'Dismissed')
      void fetchData()
    },
    [fetchData],
  )

  const sessionAction = useCallback(
    async (action: 'relink' | 'repair') => {
      try {
        await fetchJson(`/api/session/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        toast.message(`Session ${action} initiated`)
        void fetchData()
        if (action === 'relink') {
          const started = Date.now()
          const fast = window.setInterval(() => {
            void fetchData()
            if (Date.now() - started >= RELINK_FAST_POLL_DURATION_MS) {
              window.clearInterval(fast)
            }
          }, RELINK_FAST_POLL_MS)
        }
      } catch (e) {
        console.error('[Talky UI] session action', e)
        toast.error(
          action === 'relink'
            ? 'Relink request failed — is the Talky bot running?'
            : 'Repair request failed — is the Talky bot running?',
        )
      }
    },
    [fetchData],
  )

  const patchConfigDraft = useCallback(
    (patch: Partial<TalkyConfig> | ((prev: TalkyConfig) => TalkyConfig)) => {
      setConfigDraft((d) => {
        const base =
          d ?? (config ? structuredClone(config) : ({} as TalkyConfig))
        const next =
          typeof patch === 'function' ? patch(base) : { ...base, ...patch }
        return next
      })
      configDirtyRef.current = true
      setConfigDirty(true)
    },
    [config],
  )

  const resetConfigDraft = useCallback(() => {
    if (!config) return
    setConfigDraft(structuredClone(config))
    configDirtyRef.current = false
    setConfigDirty(false)
  }, [config])

  const saveConfigDraft = useCallback(async () => {
    if (!configDraft) {
      toast.error('Configuration not loaded')
      return
    }
    try {
      const body = applyPermissionsSliceToConfig(
        configDraft,
        readPermissionsSlice(configDraft),
      )
      await fetchJson<{ success: boolean }>('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      toast.success('Configuration saved')
      configDirtyRef.current = false
      setConfigDirty(false)
      void fetchData()
    } catch (e) {
      console.error('[Talky UI] save config', e)
      toast.error('Failed to save configuration')
    }
  }, [configDraft, fetchData])

  const value = useMemo(
    (): TalkyConsoleState => ({
      status,
      config,
      configDraft,
      configDirty,
      unauthorized,
      groups,
      chats,
      editingPersona,
      personaDirty,
      debugEvents,
      refresh: fetchData,
      setEditingPersona,
      savePersona,
      patchConfigDraft,
      saveConfigDraft,
      resetConfigDraft,
      resolveUnauthorized,
      sessionAction,
    }),
    [
      status,
      config,
      configDraft,
      configDirty,
      unauthorized,
      groups,
      chats,
      editingPersona,
      personaDirty,
      debugEvents,
      fetchData,
      setEditingPersona,
      savePersona,
      patchConfigDraft,
      saveConfigDraft,
      resetConfigDraft,
      resolveUnauthorized,
      sessionAction,
    ],
  )

  return (
    <TalkyConsoleContext.Provider value={value}>
      {children}
    </TalkyConsoleContext.Provider>
  )
}

export function useTalkyConsole(): TalkyConsoleState {
  const ctx = useContext(TalkyConsoleContext)
  if (!ctx) {
    throw new Error('useTalkyConsole must be used within TalkyConsoleProvider')
  }
  return ctx
}
