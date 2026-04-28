import { Eye, Loader2, MessagesSquare, ScanText, Sparkles, UserCircle2, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'
import { cn } from '@/lib/utils'
import type {
  PersonaMarkdownPreview,
  PersonaProfilesPayload,
  PersonaSuggestResponse,
  PersonaSuggestTarget,
  ChatEntry,
} from '@/types/api'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const msg =
      typeof err === 'object' && err !== null && 'error' in err
        ? String((err as { error?: string }).error)
        : res.statusText
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${msg}`)
  }
  return res.json() as Promise<T>
}

type PersonaTab = 'core' | 'profiles' | 'from-chats'

function transcriptFromEntries(entries: ChatEntry[], lastN: number): string {
  const n = Math.min(Math.max(4, lastN), 500)
  const slice = entries.slice(-n)
  return slice
    .map((e) => {
      const tag = e.role === 'incoming' ? 'peer' : 'self'
      return `[${e.timestampISO}] ${tag} ${shortJid(e.senderJid)}\n${e.text}`
    })
    .join('\n\n')
}

function mergeTranscriptFromChats(
  jids: string[],
  chatMap: Record<string, ChatEntry[]>,
  lastN: number,
): string {
  if (jids.length === 0) return ''
  const blocks: string[] = []
  for (const jid of jids) {
    const entries = chatMap[jid]
    if (!entries?.length) continue
    blocks.push(`### Conversation: ${jid}\n\n${transcriptFromEntries(entries, lastN)}`)
  }
  return blocks.join('\n\n––––––––––––––––––––\n\n')
}

function shortJid(jid: string): string {
  const [a] = jid.split('@')
  return a ?? jid
}

export function PersonaPage() {
  const [searchParams] = useSearchParams()
  const {
    editingPersona,
    personaDirty,
    setEditingPersona,
    savePersona,
    chats,
    refresh,
  } = useTalkyConsole()

  const [tab, setTab] = useState<PersonaTab>('core')

  /** Contact / group profiles */
  const [profiles, setProfiles] = useState<PersonaProfilesPayload | null>(null)
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [profileKind, setProfileKind] = useState<'contact' | 'group'>('contact')
  const [selectedStem, setSelectedStem] = useState<string | null>(null)
  const [profileContent, setProfileContent] = useState('')
  const [profileDirty, setProfileDirty] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)

  /** Improve from chats */
  const chatKeys = useMemo(() => Object.keys(chats).sort(), [chats])
  const selectionHydratedRef = useRef(false)
  const [selectedChatJids, setSelectedChatJids] = useState<string[]>([])
  const [lastN, setLastN] = useState(36)
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const [transcriptManual, setTranscriptManual] = useState(false)
  const [previewJid, setPreviewJid] = useState<string | null>(null)
  const [suggestTarget, setSuggestTarget] = useState<PersonaSuggestTarget>('recentMemory')
  const [suggestion, setSuggestion] = useState('')
  const [suggestLoading, setSuggestLoading] = useState(false)

  useEffect(() => {
    const qpTab = searchParams.get('tab')
    if (qpTab === 'profiles' || qpTab === 'from-chats') setTab(qpTab)
  }, [searchParams])

  useEffect(() => {
    if (selectionHydratedRef.current) return
    if (chatKeys.length === 0) return
    const single = searchParams.get('jid')
    const many = searchParams.getAll('jid')
    const merged = [...new Set([...(single ? [single] : []), ...many])].filter((j) =>
      chatKeys.includes(j),
    )
    if (merged.length > 0) {
      selectionHydratedRef.current = true
      setSelectedChatJids(merged)
    }
  }, [searchParams, chatKeys])

  useEffect(() => {
    if (tab !== 'profiles') return
    let alive = true
    setProfilesLoading(true)
    fetchJson<PersonaProfilesPayload>('/api/persona/profiles')
      .then((p) => {
        if (alive) setProfiles(p)
      })
      .catch(() => {
        if (alive) setProfiles(null)
      })
      .finally(() => {
        if (alive) setProfilesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tab])

  useEffect(() => {
    if (transcriptManual) return
    setTranscriptDraft(mergeTranscriptFromChats(selectedChatJids, chats, lastN))
  }, [selectedChatJids, chats, lastN, transcriptManual])

  const regenerateTranscriptFromSelection = useCallback(() => {
    setTranscriptDraft(mergeTranscriptFromChats(selectedChatJids, chats, lastN))
    setTranscriptManual(false)
  }, [selectedChatJids, chats, lastN])

  const toggleChatJid = useCallback((jid: string) => {
    setTranscriptManual(false)
    setSelectedChatJids((prev) =>
      prev.includes(jid) ? prev.filter((j) => j !== jid) : [...prev, jid],
    )
  }, [])

  const stemList: PersonaMarkdownPreview[] = useMemo(() => {
    if (!profiles) return []
    return profileKind === 'contact' ? profiles.contacts : profiles.groups
  }, [profiles, profileKind])

  useEffect(() => {
    if (!selectedStem || tab !== 'profiles') return
    let cancelled = false
    const q = new URLSearchParams({ stem: selectedStem, kind: profileKind })
    fetch(`/api/persona/profile?${q}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<{ content: string }>
      })
      .then((data) => {
        if (!cancelled) {
          setProfileContent(data.content ?? '')
          setProfileDirty(false)
        }
      })
      .catch(() => {
        if (!cancelled) setProfileContent('')
      })
    return () => {
      cancelled = true
    }
  }, [selectedStem, profileKind, tab])

  const saveProfileMarkdown = useCallback(async () => {
    if (!selectedStem) return
    setProfileSaving(true)
    try {
      await fetchJson<{ success: boolean }>('/api/persona/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: profileKind,
          stem: selectedStem,
          content: profileContent,
        }),
      })
      setProfileDirty(false)
      void refresh()
      const pr = await fetchJson<PersonaProfilesPayload>('/api/persona/profiles')
      setProfiles(pr)
      toast.success(`Saved persona/${profileKind}/${selectedStem}.md`)
    } catch (e) {
      console.error(e)
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setProfileSaving(false)
    }
  }, [selectedStem, profileKind, profileContent, refresh])

  const runSuggestion = useCallback(async () => {
    if (!transcriptDraft.trim()) {
      toast.message('Select one or more chats or paste a transcript.')
      return
    }
    setSuggestLoading(true)
    setSuggestion('')
    try {
      const body = {
        transcript: transcriptDraft,
        target: suggestTarget,
        currentSoul: editingPersona.soul,
        currentCommunicationRules: editingPersona.communicationRules,
        currentRecentMemory: editingPersona.recentMemory,
      }
      const res = await fetchJson<PersonaSuggestResponse>('/api/persona/suggest-from-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setSuggestion(res.suggestion ?? '')
    } catch (e) {
      console.error(e)
      toast.error(
        e instanceof Error ? e.message : 'Suggestion failed — is the bot running with a Gemini key?',
      )
    } finally {
      setSuggestLoading(false)
    }
  }, [transcriptDraft, suggestTarget, editingPersona])

  const appendSuggestionTo = useCallback(
    (target: PersonaSuggestTarget) => {
      const block = suggestion.trim()
      if (!block) return
      const glue = (prev: string) =>
        prev.trim().length === 0 ? block : `${prev.trimEnd()}\n\n---\n${block}`
      if (target === 'soul') {
        setEditingPersona({ ...editingPersona, soul: glue(editingPersona.soul) })
      } else if (target === 'communicationRules') {
        setEditingPersona({
          ...editingPersona,
          communicationRules: glue(editingPersona.communicationRules),
        })
      } else {
        setEditingPersona({ ...editingPersona, recentMemory: glue(editingPersona.recentMemory) })
      }
      setTab('core')
      toast.success('Merged into draft — review Core files and click Save core.')
    },
    [editingPersona, setEditingPersona, suggestion],
  )

  const previewMessages = previewJid ? (chats[previewJid] ?? []) : []

  return (
    <div className="flex flex-col gap-6">
      <Sheet open={previewJid !== null} onOpenChange={(open) => !open && setPreviewJid(null)}>
        <SheetContent
          side="right"
          showCloseButton
          className="flex h-full max-h-screen w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl md:max-w-2xl"
        >
          {previewJid ? (
            <>
              <SheetHeader className="flex shrink-0 flex-row items-start justify-between gap-2 border-b px-4 py-3 pr-14">
                <div className="min-w-0">
                  <SheetTitle className="break-all font-mono text-sm leading-snug">
                    {previewJid}
                  </SheetTitle>
                  <SheetDescription>
                    Full history ({previewMessages.length} message
                    {previewMessages.length === 1 ? '' : 's'}). Preview only — selection uses the
                    last N messages per chat for the transcript on the left.
                  </SheetDescription>
                </div>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1 px-4 py-3">
                <div className="flex flex-col gap-3 pb-6 pr-2">
                  {previewMessages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No messages loaded for this chat.</p>
                  ) : (
                    previewMessages.map((msg, i) => (
                      <div
                        key={`${msg.timestampISO}-${i}`}
                        className={cn(
                          'flex max-w-[95%] flex-col gap-1 rounded-2xl border px-3 py-2 shadow-sm',
                          msg.role === 'outgoing'
                            ? 'self-end bg-primary/10'
                            : 'self-start bg-card',
                        )}
                      >
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {msg.role === 'outgoing' ? 'Talky' : shortJid(msg.senderJid)}
                          </span>
                          <span>{new Date(msg.timestampISO).toLocaleString()}</span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.text}</p>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Persona</h1>
          <p className="text-muted-foreground max-w-2xl">
            Core voice in <code className="text-xs">persona/*.md</code>, per-contact tweaks, and
            AI-assisted updates from real chat logs — improve your voice as you go.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {tab === 'core' ? (
            <>
              {personaDirty ? (
                <span className="text-sm text-amber-600 dark:text-amber-400">Unsaved core changes</span>
              ) : (
                <span className="text-sm text-muted-foreground">Synced from disk</span>
              )}
              <Button type="button" onClick={() => void savePersona()} disabled={!personaDirty}>
                Save core
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        <Button
          type="button"
          variant={tab === 'core' ? 'default' : 'ghost'}
          size="sm"
          className="gap-1.5"
          onClick={() => setTab('core')}
        >
          <ScanText className="size-4" /> Core files
        </Button>
        <Button
          type="button"
          variant={tab === 'profiles' ? 'default' : 'ghost'}
          size="sm"
          className="gap-1.5"
          onClick={() => setTab('profiles')}
        >
          <UserCircle2 className="size-4" /> Contacts & groups
        </Button>
        <Button
          type="button"
          variant={tab === 'from-chats' ? 'default' : 'ghost'}
          size="sm"
          className="gap-1.5"
          onClick={() => setTab('from-chats')}
        >
          <MessagesSquare className="size-4" /> From chats
        </Button>
      </div>

      {tab === 'core' ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Soul</CardTitle>
              <CardDescription>
                Written to <code className="text-xs">persona/soul.md</code>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Label htmlFor="soul">Content</Label>
              <Textarea
                id="soul"
                rows={12}
                value={editingPersona.soul}
                onChange={(e) =>
                  setEditingPersona({ ...editingPersona, soul: e.target.value })
                }
                className="font-mono text-sm"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Communication rules</CardTitle>
              <CardDescription>
                Written to <code className="text-xs">persona/communication_rules.md</code>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Label htmlFor="rules">Content</Label>
              <Textarea
                id="rules"
                rows={12}
                value={editingPersona.communicationRules}
                onChange={(e) =>
                  setEditingPersona({
                    ...editingPersona,
                    communicationRules: e.target.value,
                  })
                }
                className="font-mono text-sm"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent memory</CardTitle>
              <CardDescription>
                Written to <code className="text-xs">persona/recent_memory.md</code>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Label htmlFor="recent">Content</Label>
              <Textarea
                id="recent"
                rows={10}
                value={editingPersona.recentMemory}
                onChange={(e) =>
                  setEditingPersona({
                    ...editingPersona,
                    recentMemory: e.target.value,
                  })
                }
                className="font-mono text-sm"
              />
            </CardContent>
          </Card>
        </>
      ) : null}

      {tab === 'profiles' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="size-4" /> Contact & group profiles
            </CardTitle>
            <CardDescription>
              Files under <code className="text-xs">persona/contacts/</code> and{' '}
              <code className="text-xs">persona/groups/</code>. Auto-learned bullets from chats sync
              into contact files when extraction runs — edit here anytime.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Select
                  value={profileKind}
                  onValueChange={(v) => {
                    const k = v as 'contact' | 'group'
                    setProfileKind(k)
                    setSelectedStem(null)
                    setProfileContent('')
                    setProfileDirty(false)
                  }}
                >
                  <SelectTrigger size="sm" className="w-full md:w-auto">
                    <SelectValue placeholder="Kind" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contact">Contacts</SelectItem>
                    <SelectItem value="group">Groups</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {profilesLoading ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Loading list…
                </p>
              ) : (
                <ScrollArea className="h-[360px] rounded-md border p-2">
                  <div className="flex flex-col gap-1">
                    {stemList.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-2">No Markdown files yet.</p>
                    ) : (
                      stemList.map((row) => (
                        <button
                          type="button"
                          key={`${profileKind}:${row.stem}`}
                          onClick={() => {
                            setSelectedStem(row.stem)
                          }}
                          className={`text-left rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent ${
                            selectedStem === row.stem ? 'bg-accent font-medium' : ''
                          }`}
                          title={row.preview}
                        >
                          <span className="line-clamp-2 break-all">{row.stem}</span>
                        </button>
                      ))
                    )}
                  </div>
                </ScrollArea>
              )}
            </div>
            <div className="flex min-h-[360px] flex-col gap-2">
              <Label htmlFor="profile-md">
                {selectedStem ? `${profileKind}: ${selectedStem}` : 'Select a profile'}
              </Label>
              <Textarea
                id="profile-md"
                className="min-h-[280px] flex-1 font-mono text-sm"
                value={profileContent}
                disabled={!selectedStem}
                onChange={(e) => {
                  setProfileContent(e.target.value)
                  setProfileDirty(true)
                }}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!selectedStem || profileSaving || !profileDirty}
                  onClick={() => void saveProfileMarkdown()}
                >
                  {profileSaving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    'Save profile file'
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {tab === 'from-chats' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="size-4" /> Chats → transcript
              </CardTitle>
              <CardDescription>
                Select <span className="font-medium">one or more</span> threads. Each contributes
                the <span className="font-medium">last N messages</span> (below), merged into one
                prompt. Use <span className="font-medium">Preview</span> to open a slide-over with
                the full message history before you commit.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="text-foreground">Selected threads</Label>
                  <Badge variant="secondary">{selectedChatJids.length}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={chatKeys.length === 0}
                    onClick={() => {
                      setTranscriptManual(false)
                      setSelectedChatJids([...chatKeys])
                    }}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={selectedChatJids.length === 0}
                    onClick={() => {
                      setTranscriptManual(false)
                      setSelectedChatJids([])
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              <ScrollArea className="h-[220px] rounded-md border">
                <ul className="flex flex-col divide-y p-0">
                  {chatKeys.length === 0 ? (
                    <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No chats loaded yet — open the bot and history will appear here.
                    </li>
                  ) : (
                    chatKeys.map((jid) => {
                      const checked = selectedChatJids.includes(jid)
                      const n = chats[jid]?.length ?? 0
                      return (
                        <li
                          key={jid}
                          className={cn(
                            'flex flex-wrap items-center gap-2 px-2 py-2 transition-colors',
                            checked ? 'bg-accent/40' : 'hover:bg-muted/50',
                          )}
                        >
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              className="size-4 shrink-0 rounded border-input"
                              checked={checked}
                              onChange={() => toggleChatJid(jid)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-xs text-foreground">
                                {jid}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {shortJid(jid)} · {n} message{n === 1 ? '' : 's'}
                              </span>
                            </span>
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0 gap-1"
                            onClick={() => setPreviewJid(jid)}
                          >
                            <Eye className="size-4" />
                            Preview
                          </Button>
                        </li>
                      )
                    })
                  )}
                </ul>
              </ScrollArea>

              <div className="grid gap-2 sm:max-w-[200px]">
                <Label htmlFor="lastn">Messages per chat (from end)</Label>
                <Input
                  id="lastn"
                  type="number"
                  min={4}
                  max={500}
                  value={lastN}
                  onChange={(e) => setLastN(Number(e.target.value) || 36)}
                />
              </div>

              {transcriptManual ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Transcript edited by hand — selection changes won’t overwrite until you regenerate.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="tx">Merged transcript (editable)</Label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={selectedChatJids.length === 0}
                  onClick={() => regenerateTranscriptFromSelection()}
                >
                  Regenerate from selection
                </Button>
              </div>
              <Textarea
                id="tx"
                rows={14}
                className="font-mono text-xs"
                value={transcriptDraft}
                onChange={(e) => {
                  setTranscriptDraft(e.target.value)
                  setTranscriptManual(true)
                }}
              />

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label>Suggestion target</Label>
                  <Select
                    value={suggestTarget}
                    onValueChange={(v) => setSuggestTarget(v as PersonaSuggestTarget)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="soul">Soul (identity)</SelectItem>
                      <SelectItem value="communicationRules">Communication rules</SelectItem>
                      <SelectItem value="recentMemory">Recent memory</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    className="w-full gap-2"
                    disabled={suggestLoading}
                    onClick={() => void runSuggestion()}
                  >
                    {suggestLoading ? (
                      <>
                        <Loader2 className="size-4 animate-spin" /> Working…
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-4" /> Suggest persona text
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Merge into core</CardTitle>
              <CardDescription>
                Review the model output, then append it to the right file. You stay in control —
                open <span className="font-medium">Core files</span> to edit, then Save core.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Textarea
                rows={18}
                className="font-mono text-sm"
                placeholder="Suggestion appears here…"
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!suggestion.trim()}
                  onClick={() => appendSuggestionTo('soul')}
                >
                  Append to soul
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!suggestion.trim()}
                  onClick={() => appendSuggestionTo('communicationRules')}
                >
                  Append to rules
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!suggestion.trim()}
                  onClick={() => appendSuggestionTo('recentMemory')}
                >
                  Append to recent memory
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
