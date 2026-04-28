import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'

export function DashboardPage() {
  const { status, config } = useTalkyConsole()

  if (!status || !config) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full max-w-3xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Runtime status and loaded configuration from the Talky control server.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Card className="min-w-[200px] flex-1">
          <CardHeader className="pb-2">
            <CardDescription>Process</CardDescription>
            <CardTitle className="text-lg capitalize">{status.status}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Web control port {status.port}
          </CardContent>
        </Card>
        <Card className="min-w-[200px] flex-1">
          <CardHeader className="pb-2">
            <CardDescription>Bot</CardDescription>
            <CardTitle className="text-lg">
              {typeof config.botName === 'string' ? config.botName : '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Model{' '}
            {typeof config.model === 'string' ? config.model : '—'}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Runtime config (JSON)</CardTitle>
          <CardDescription>
            Full snapshot from <code className="text-xs">GET /api/config</code>. Editable
            forms are planned; for now use the Persona and config files on disk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[480px] overflow-auto rounded-lg border bg-muted/50 p-4 text-left text-xs leading-relaxed">
            {JSON.stringify(config, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
