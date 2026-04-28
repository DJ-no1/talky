import { useCallback, useMemo, useState } from 'react'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'
import type { DirectChatMode, PermissionsPanelSlice } from '@/types/api'
import {
  asStringArray,
  normalizeJidList,
  readPermissionsSlice,
} from '@/types/api'

function JidListSection({
  title,
  description,
  items,
  onItemsChange,
}: {
  title: string
  description: string
  items: string[]
  onItemsChange: (next: string[]) => void
}) {
  const [pending, setPending] = useState('')

  const addRow = () => {
    const t = pending.trim()
    if (!t) return
    const norm = normalizeJidList([...items, t])
    if (norm.length === items.length) {
      toast.warning('Already in list')
      return
    }
    onItemsChange(norm)
    setPending('')
  }

  const updateAt = (index: number, raw: string) => {
    const next = [...items]
    next[index] = raw
    onItemsChange(next)
  }

  const blurNormalize = (index: number) => {
    const row = items[index]?.trim() ?? ''
    const without = items.filter((_, i) => i !== index)
    const merged = row ? [...without, row] : without
    onItemsChange(normalizeJidList(merged))
  }

  const removeAt = (index: number) => {
    onItemsChange(items.filter((_, i) => i !== index))
  }

  return (
    <Card className="border bg-card">
      <CardHeader className="gap-1">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {items.length === 0 ? (
            <li className="text-sm text-muted-foreground">No entries yet.</li>
          ) : (
            items.map((jid, i) => (
              <li key={`${jid}-${i}`} className="flex gap-2">
                <Input
                  className="font-mono text-sm"
                  value={jid}
                  placeholder="user@s.whatsapp.net or group@g.us"
                  onChange={(e) => updateAt(i, e.target.value)}
                  onBlur={() => blurNormalize(i)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  aria-label={`Remove ${jid}`}
                  onClick={() => removeAt(i)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            ))
          )}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            className="font-mono text-sm sm:flex-1"
            value={pending}
            placeholder="Add JID…"
            onChange={(e) => setPending(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addRow()
              }
            }}
          />
          <Button type="button" variant="secondary" className="gap-1 sm:w-auto" onClick={addRow}>
            <PlusIcon className="size-4" />
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function PermissionRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-base">
          {label}
        </Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function AllowlistsPage() {
  const {
    config,
    configDraft,
    configDirty,
    groups,
    patchConfigDraft,
    saveConfigDraft,
    resetConfigDraft,
  } = useTalkyConsole()

  const slice = useMemo(
    () => (configDraft ? readPermissionsSlice(configDraft) : null),
    [configDraft],
  )

  const [groupSearch, setGroupSearch] = useState('')
  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) => g.name.toLowerCase().includes(q))
  }, [groups, groupSearch])

  const patchSlice = useCallback(
    (partial: Partial<PermissionsPanelSlice>) => {
      patchConfigDraft((prev) => ({
        ...prev,
        ...partial,
      }))
    },
    [patchConfigDraft],
  )

  if (!config || !configDraft || !slice) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const mode: DirectChatMode = slice.directChatMode

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Allowlists & permissions</h1>
          <p className="text-muted-foreground">
            Control who can reach the bot and how groups behave. Changes apply after Save.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {configDirty ? (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Unsaved changes
            </span>
          ) : null}
          <Button type="button" variant="outline" disabled={!configDirty} onClick={resetConfigDraft}>
            Reset
          </Button>
          <Button type="button" disabled={!configDirty} onClick={() => void saveConfigDraft()}>
            Save
          </Button>
        </div>
      </div>

      <Card className="border bg-card">
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Direct chats</CardTitle>
          <CardDescription>
            Who may DM the bot — combine with the allowlist entries below when mode is allowlist.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Direct chat mode</Label>
            <ToggleGroup
              multiple={false}
              spacing={0}
              variant="outline"
              value={[mode]}
              onValueChange={(next) => {
                const pick =
                  next.find(
                    (v): v is DirectChatMode =>
                      v === 'allowlist' || v === 'all' || v === 'none',
                  ) ?? mode
                patchSlice({ directChatMode: pick })
              }}
              className="w-full justify-stretch sm:w-fit"
            >
              <ToggleGroupItem value="allowlist" className="flex-1 px-3 text-xs sm:flex-none sm:text-sm">
                Allowlist
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className="flex-1 px-3 text-xs sm:flex-none sm:text-sm">
                All
              </ToggleGroupItem>
              <ToggleGroupItem value="none" className="flex-1 px-3 text-xs sm:flex-none sm:text-sm">
                None
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">Allowlist</strong> uses the list below.
              <strong className="font-medium text-foreground"> All</strong> permits any DM.
              <strong className="font-medium text-foreground"> None</strong> blocks all DMs.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border bg-card">
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Reply behavior</CardTitle>
          <CardDescription>Mentions, confirmations, groups, and self-chat.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <PermissionRow
            id="reply-only-mention"
            label="Reply only when mentioned"
            description="In groups, ignore messages unless you are @mentioned (when applicable)."
            checked={slice.replyOnlyOnMention}
            onCheckedChange={(checked) => patchSlice({ replyOnlyOnMention: checked })}
          />
          <PermissionRow
            id="ask-before-reply"
            label="Ask before replying"
            description="Defer replies until approved by policy / tooling."
            checked={slice.askBeforeReply}
            onCheckedChange={(checked) => patchSlice({ askBeforeReply: checked })}
          />
          <PermissionRow
            id="always-allowed-groups"
            label="Always reply in allowed groups"
            description="Treat allowed groups as always-on for replies (subject to other guards)."
            checked={slice.alwaysReplyInAllowedGroups}
            onCheckedChange={(checked) =>
              patchSlice({ alwaysReplyInAllowedGroups: checked })
            }
          />
          <PermissionRow
            id="self-chat"
            label="Self-chat enabled"
            description="Allow configured self-chat / digest flows."
            checked={slice.selfChatEnabled}
            onCheckedChange={(checked) => patchSlice({ selfChatEnabled: checked })}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <JidListSection
          title="Allowed direct JIDs"
          description="Private chats that may message the bot when mode is allowlist."
          items={asStringArray(configDraft.allowedDirectJids)}
          onItemsChange={(next) =>
            patchConfigDraft({ allowedDirectJids: normalizeJidList(next) })
          }
        />
        <JidListSection
          title="Allowed group JIDs"
          description="Groups the bot is permitted to join and use."
          items={asStringArray(configDraft.allowedGroupJids)}
          onItemsChange={(next) =>
            patchConfigDraft({ allowedGroupJids: normalizeJidList(next) })
          }
        />
      </div>

      <JidListSection
        title="Muted group JIDs"
        description="Groups where the bot should stay quiet (still listed for reference)."
        items={asStringArray(configDraft.mutedGroupJids)}
        onItemsChange={(next) =>
          patchConfigDraft({ mutedGroupJids: normalizeJidList(next) })
        }
      />

      <Card className="border bg-card">
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Available groups</CardTitle>
          <CardDescription>
            Groups visible to the WhatsApp session (from <code className="text-xs">/api/groups</code>).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            className="max-w-md"
            placeholder="Search by name…"
            value={groupSearch}
            onChange={(e) => setGroupSearch(e.target.value)}
            aria-label="Filter available groups by name"
          />
          <ul className="flex flex-col gap-3">
            {filteredGroups.length === 0 ? (
              <li className="text-sm text-muted-foreground">
                {groups.length === 0 ? 'No groups loaded.' : 'No groups match this search.'}
              </li>
            ) : (
              filteredGroups.map((g, i) => (
                <li key={g.jid}>
                  <div className="font-medium">{g.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{g.jid}</div>
                  {i < filteredGroups.length - 1 ? <Separator className="my-2" /> : null}
                </li>
              ))
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
