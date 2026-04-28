import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'

export function InboxPage() {
  const { unauthorized, resolveUnauthorized } = useTalkyConsole()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-muted-foreground">
          Unauthorized contacts or groups that messaged you outside allowlists.
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
    </div>
  )
}
