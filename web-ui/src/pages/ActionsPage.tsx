import { RefreshCw, Stethoscope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'

export function ActionsPage() {
  const { sessionAction } = useTalkyConsole()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
        <p className="text-muted-foreground">
          WhatsApp session maintenance — same endpoints as CLI{' '}
          <code className="text-xs">relink</code> / repair flows.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw />
              Relink session
            </CardTitle>
            <CardDescription>
              Starts a fresh pairing flow when credentials expire (watch terminal QR if enabled).
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="button" onClick={() => void sessionAction('relink')}>
              Run relink
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Stethoscope />
              Repair session
            </CardTitle>
            <CardDescription>
              Attempts internal recovery without forcing new QR where possible.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="button" variant="secondary" onClick={() => void sessionAction('repair')}>
              Run repair
            </Button>
          </CardFooter>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roadmap</CardTitle>
          <CardDescription>
            Inline QR preview and connection badges will land here next (see FEATURE_REQUESTS §1.2).
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Session buttons already POST to <code className="text-xs">/api/session/relink</code>{' '}
          and <code className="text-xs">/api/session/repair</code>.
        </CardContent>
      </Card>
    </div>
  )
}
