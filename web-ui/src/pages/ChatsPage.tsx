import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
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
  const { chats, debugEvents } = useTalkyConsole()
  const jids = useMemo(() => Object.keys(chats).sort(), [chats])
  const [selectedJid, setSelectedJid] = useState<string | null>(null)

  const chatDebugEvents = useMemo(() => {
    if (!selectedJid) return []
    return debugEvents.filter((e) => e.chatJid === selectedJid)
  }, [debugEvents, selectedJid])

  return (
    <div className="flex flex-col gap-6">
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
                    <li key={jid}>
                      <button
                        type="button"
                        onClick={() => setSelectedJid(jid)}
                        className={
                          selectedJid === jid
                            ? 'w-full rounded-md bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground'
                            : 'w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted'
                        }
                      >
                        <span className="block truncate">{jid}</span>
                        <span className="text-xs opacity-80">
                          {chats[jid]?.length ?? 0} messages
                        </span>
                      </button>
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
                <CardTitle className="font-mono text-base">{selectedJid}</CardTitle>
                <CardDescription>
                  {chats[selectedJid].length} message
                  {chats[selectedJid].length === 1 ? '' : 's'}
                </CardDescription>
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
                              ? 'Talky'
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
