import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'
import { cn } from '@/lib/utils'
import type { ChatEntry } from '@/types/api'

function lastEntry(entries: ChatEntry[] | undefined): ChatEntry | null {
  if (!entries?.length) return null
  return entries[entries.length - 1] ?? null
}

export function InboxPage() {
  const { unauthorized, resolveUnauthorized, chats } = useTalkyConsole()

  const threads = useMemo(() => {
    const rows: {
      jid: string
      messageCount: number
      lastAt: string
      preview: string
    }[] = []
    for (const [jid, entries] of Object.entries(chats)) {
      const last = lastEntry(entries)
      if (!last) continue
      rows.push({
        jid,
        messageCount: entries.length,
        lastAt: last.timestampISO,
        preview: last.text.length > 160 ? `${last.text.slice(0, 157)}…` : last.text,
      })
    }
    rows.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    return rows
  }, [chats])

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-muted-foreground">
          Unauthorized senders need review. Recorded threads below come from{' '}
          <code className="text-xs">data/chats/*.md</code> (same list as{' '}
          <Link className="underline underline-offset-4" to="/chats">
            Chats
          </Link>
          ).
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium">Needs review</h2>
          <p className="text-sm text-muted-foreground">
            Contacts or groups that messaged you outside allowlists.
          </p>
        </div>

        {unauthorized.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unauthorized messages detected.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sender</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead>Last reason</TableHead>
                <TableHead className="max-w-[200px]">Preview</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unauthorized.map((u) => (
                <TableRow key={u.jid}>
                  <TableCell>
                    <div className="font-medium">{u.name || 'Unknown'}</div>
                    <div className="font-mono text-xs text-muted-foreground">{u.jid}</div>
                  </TableCell>
                  <TableCell>{u.kind}</TableCell>
                  <TableCell className="text-right">{u.count}</TableCell>
                  <TableCell className="max-w-[240px] truncate">{u.lastReason}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground text-sm">
                    {u.lastPreview ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => void resolveUnauthorized(u.jid, 'allow', u.kind)}
                      >
                        Allow
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void resolveUnauthorized(u.jid, 'discard', u.kind)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium">Recorded conversations</h2>
          <p className="text-sm text-muted-foreground">
            Markdown logs the bot keeps for each thread (newest first).
          </p>
        </div>

        {threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recorded threads yet. After the bot receives or sends messages, they appear here and
            under Chats.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chat</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead className="max-w-[280px]">Last message</TableHead>
                <TableHead className="text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {threads.map((t) => (
                <TableRow key={t.jid}>
                  <TableCell>
                    <div className="font-mono text-xs break-all">{t.jid}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.messageCount}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(t.lastAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    <span className="line-clamp-2 text-sm text-muted-foreground">{t.preview}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                      to={`/chats?jid=${encodeURIComponent(t.jid)}`}
                    >
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}
