import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Trash2Icon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'
import type { DebugLogEvent } from '@/types/api'

function shortJid(jid: string) {
  const [a] = jid.split('@')
  return a ?? jid
}

function DebugPanel({ events }: { events: DebugLogEvent[] }) {
  return (
    <ScrollArea className="h-[280px] rounded-lg border bg-muted/30">
      <div className="flex flex-col gap-2 p-3">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No debug events for this chat.</p>
        ) : (
          events.slice(0, 120).map((event, i) => (
            <div
              key={`${event.timestampISO}-${i}`}
              className="rounded-md border bg-card p-2 text-sm shadow-xs"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={
                    event.source === 'tool'
                      ? 'font-semibold text-purple-700 dark:text-purple-400'
                      : 'font-semibold text-teal-700 dark:text-teal-400'
                  }
                >
                  {event.source.toUpperCase()}
                </span>
                {event.tool ? <span>tool={event.tool}</span> : null}
                {event.decision ? <span>decision={event.decision}</span> : null}
                {typeof event.ok === 'boolean' ? (
                  <span className={event.ok ? 'text-green-600' : 'text-destructive'}>
                    {event.ok ? 'ok' : 'fail'}
                  </span>
                ) : null}
                <span>{new Date(event.timestampISO).toLocaleTimeString()}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap leading-snug">{event.message || event.raw}</p>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  )
}

export function ChatsPage() {
  const { chats, debugEvents, deleteChat } = useTalkyConsole()
  const [searchParams, setSearchParams] = useSearchParams()
  const jids = useMemo(() => Object.keys(chats).sort(), [chats])
  const [selectedJid, setSelectedJid] = useState<string | null>(null)
  const [deletingJid, setDeletingJid] = useState<string | null>(null)
  const [pendingDeleteJid, setPendingDeleteJid] = useState<string | null>(null)

  const jidFromUrl = searchParams.get('jid')

  useEffect(() => {
    if (!jidFromUrl) {
      setSelectedJid(null)
      return
    }
    if (Object.prototype.hasOwnProperty.call(chats, jidFromUrl)) {
      setSelectedJid(jidFromUrl)
    }
  }, [jidFromUrl, chats])

  const selectThread = (jid: string | null) => {
    setSelectedJid(jid)
    setSearchParams(
      (prev: URLSearchParams) => {
        const next = new URLSearchParams(prev)
        if (jid) next.set('jid', jid)
        else next.delete('jid')
        return next
      },
      { replace: true },
    )
  }

  const chatDebugEvents = useMemo(() => {
    if (!selectedJid) return []
    return debugEvents.filter((e) => e.chatJid === selectedJid)
  }, [debugEvents, selectedJid])

  const runPendingDelete = async () => {
    const jid = pendingDeleteJid
    if (!jid) return
    setDeletingJid(jid)
    try {
      const ok = await deleteChat(jid)
      if (ok) {
        setPendingDeleteJid(null)
        if (selectedJid === jid) selectThread(null)
      }
    } finally {
      setDeletingJid(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AlertDialog
        open={pendingDeleteJid !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setPendingDeleteJid(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat history?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved Markdown file under{' '}
              <code className="text-xs">data/chats/</code> for this thread. Decision and tool logs in{' '}
              <code className="text-xs">data/logs/</code> are not removed. This cannot be undone.
              {pendingDeleteJid ? (
                <span className="mt-3 block font-mono text-xs break-all text-foreground">
                  {pendingDeleteJid}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={deletingJid !== null}
              onClick={(e) => {
                e.preventDefault()
                void runPendingDelete()
              }}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        <p className="text-muted-foreground">
          Parsed histories from <code className="text-xs">data/chats/*.md</code> with tool and
          decision traces for the selected thread.
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="w-full lg:max-w-xs lg:shrink-0">
          <CardHeader>
            <CardTitle className="text-base">Threads</CardTitle>
            <CardDescription>{jids.length} conversations</CardDescription>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <ScrollArea className="h-[min(70vh,560px)]">
              <ul className="flex flex-col gap-1 pr-3">
                {jids.length === 0 ? (
                  <li className="text-sm text-muted-foreground">No chats yet.</li>
                ) : (
                  jids.map((jid) => (
                    <li key={jid} className="flex min-w-0 items-stretch gap-0.5">
                      <button
                        type="button"
                        onClick={() => selectThread(jid)}
                        className={
                          selectedJid === jid
                            ? 'min-w-0 flex-1 rounded-md bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground'
                            : 'min-w-0 flex-1 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted'
                        }
                      >
                        <span className="block truncate">{jid}</span>
                        <span className="text-xs opacity-80">
                          {chats[jid]?.length ?? 0} messages
                        </span>
                      </button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="shrink-0 text-muted-foreground hover:text-destructive"
                              disabled={deletingJid === jid}
                              onClick={(e) => {
                                e.stopPropagation()
                                setPendingDeleteJid(jid)
                              }}
                              aria-label="Delete chat history"
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipContent side="left">Delete saved history</TooltipContent>
                      </Tooltip>
                    </li>
                  ))
                )}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="min-h-[480px] flex-1">
          {!selectedJid ? (
            <CardContent className="flex h-[400px] items-center justify-center text-muted-foreground">
              Select a chat to view messages.
            </CardContent>
          ) : !chats[selectedJid] ? (
            <CardContent className="flex items-center gap-3 py-8">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-64" />
              </div>
            </CardContent>
          ) : (
            <>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <CardTitle className="font-mono text-base break-all">{selectedJid}</CardTitle>
                    <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        {chats[selectedJid].length} message
                        {chats[selectedJid].length === 1 ? '' : 's'}
                      </span>
                      <Link
                        to={`/persona?tab=from-chats&jid=${encodeURIComponent(selectedJid)}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        Improve persona from this chat →
                      </Link>
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    disabled={deletingJid === selectedJid}
                    onClick={() => setPendingDeleteJid(selectedJid)}
                  >
                    <Trash2Icon className="size-3.5" />
                    Delete conversation
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ScrollArea className="h-[min(50vh,480px)] rounded-lg border bg-muted/20">
                  <div className="flex flex-col gap-3 p-4">
                    {chats[selectedJid].map((msg, i) => (
                      <div
                        key={`${msg.timestampISO}-${i}`}
                        className={
                          msg.role === 'outgoing'
                            ? 'flex max-w-[85%] flex-col gap-1 self-end rounded-2xl border bg-primary/10 px-3 py-2'
                            : 'flex max-w-[85%] flex-col gap-1 self-start rounded-2xl border bg-card px-3 py-2 shadow-sm'
                        }
                      >
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {msg.role === 'outgoing'
                              ? msg.manualOutbound
                                ? 'You'
                                : 'Talky'
                              : shortJid(msg.senderJid)}
                          </span>
                          <span>{new Date(msg.timestampISO).toLocaleString()}</span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.text}</p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>

                <div>
                  <h2 className="mb-2 text-sm font-medium">Tool + decision debug</h2>
                  <DebugPanel events={chatDebugEvents} />
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
