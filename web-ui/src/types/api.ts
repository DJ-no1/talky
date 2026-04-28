/** Mirrors control-server GET `/api/models`. */
export type GeminiModelOption = {
  id: string
  displayName: string
}

export type ModelsPayload = {
  models: GeminiModelOption[]
  currentModel: string
}

/** Mirrors control-server + storage shapes. Keep aligned with talky `src/types.ts` / `storage.ts`. */

export type StatusPayload = {
  status: string
  port: number
  /** Raw Baileys pairing string; null when not awaiting scan. */
  whatsappQr: string | null
  whatsappNeedsQr: boolean
  whatsappConnected: boolean
  whatsappConnection: 'open' | 'close' | 'connecting' | null
}

export type ChatEntry = {
  timestampISO: string
  role: 'incoming' | 'outgoing'
  senderJid: string
  text: string
}

export type UnauthorizedCandidate = {
  jid: string
  name: string
  count: number
  lastReason: string
  kind: 'direct' | 'group'
  lastSeen: string
  lastPreview?: string
}

export type GroupRow = { jid: string; name: string }

export type DebugLogEvent = {
  timestampISO: string
  source: 'decision' | 'tool'
  chatJid?: string
  senderJid?: string
  tool?: string
  decision?: string
  ok?: boolean
  message: string
  raw: string
}

export type PersonaPayload = {
  soul: string
  communicationRules: string
  recentMemory: string
}

/** Full runtime config JSON from `/api/config`. */
export type TalkyConfig = Record<string, unknown>

/** Mirrors `AppConfig['directChatMode']` — safe for UI without importing server package. */
export type DirectChatMode = 'allowlist' | 'all' | 'none'

/** Permissions / allowlists subset editable from the web panel (aligned with root `AppConfig`). */
export type PermissionsPanelSlice = {
  allowedDirectJids: string[]
  allowedGroupJids: string[]
  mutedGroupJids: string[]
  directChatMode: DirectChatMode
  replyOnlyOnMention: boolean
  askBeforeReply: boolean
  alwaysReplyInAllowedGroups: boolean
  selfChatEnabled: boolean
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

/** Trim, drop empties, dedupe while preserving first-seen order. */
export function normalizeJidList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

export function readBoolean(config: TalkyConfig, key: string, fallback = false): boolean {
  const v = config[key]
  return typeof v === 'boolean' ? v : fallback
}

export function readDirectChatMode(config: TalkyConfig): DirectChatMode {
  const v = config.directChatMode
  if (v === 'allowlist' || v === 'all' || v === 'none') return v
  return 'allowlist'
}

/** Read permission-related fields from a loose config object for forms. */
export function readPermissionsSlice(config: TalkyConfig): PermissionsPanelSlice {
  return {
    allowedDirectJids: normalizeJidList(asStringArray(config.allowedDirectJids)),
    allowedGroupJids: normalizeJidList(asStringArray(config.allowedGroupJids)),
    mutedGroupJids: normalizeJidList(asStringArray(config.mutedGroupJids)),
    directChatMode: readDirectChatMode(config),
    replyOnlyOnMention: readBoolean(config, 'replyOnlyOnMention'),
    askBeforeReply: readBoolean(config, 'askBeforeReply'),
    alwaysReplyInAllowedGroups: readBoolean(config, 'alwaysReplyInAllowedGroups'),
    selfChatEnabled: readBoolean(config, 'selfChatEnabled'),
  }
}

/** Apply normalized permission fields onto a full config snapshot before POST. */
export function applyPermissionsSliceToConfig(
  base: TalkyConfig,
  slice: PermissionsPanelSlice,
): TalkyConfig {
  return {
    ...base,
    allowedDirectJids: normalizeJidList(slice.allowedDirectJids),
    allowedGroupJids: normalizeJidList(slice.allowedGroupJids),
    mutedGroupJids: normalizeJidList(slice.mutedGroupJids),
    directChatMode: slice.directChatMode,
    replyOnlyOnMention: slice.replyOnlyOnMention,
    askBeforeReply: slice.askBeforeReply,
    alwaysReplyInAllowedGroups: slice.alwaysReplyInAllowedGroups,
    selfChatEnabled: slice.selfChatEnabled,
  }
}
