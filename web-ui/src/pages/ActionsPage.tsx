import { useEffect, useState } from 'react'
import { RefreshCw, Stethoscope } from 'lucide-react'
import QRCode from 'react-qr-code'
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

const QR_POLL_MS = 1500

export function ActionsPage() {
  const { sessionAction, status, refresh } = useTalkyConsole()
  const [expectingQr, setExpectingQr] = useState(false)

  const qrValue = status?.whatsappQr ?? null
  const waConnected = status?.whatsappConnected === true
  const needsQr = status?.whatsappNeedsQr === true
  const showQrUi = (expectingQr || needsQr) && !waConnected

  useEffect(() => {
    if (waConnected) setExpectingQr(false)
  }, [waConnected])

  useEffect(() => {
    if (!showQrUi) return
    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, QR_POLL_MS)
    return () => window.clearInterval(id)
  }, [showQrUi, refresh])

  const runRelink = () => {
    setExpectingQr(true)
    void sessionAction('relink')
  }

  const runRepair = () => {
    void sessionAction('repair')
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
        <p className="text-muted-foreground">
          WhatsApp session maintenance — same endpoints as CLI{' '}
          <code className="text-xs">relink</code> / repair flows.
        </p>
      </div>

      {showQrUi && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">WhatsApp pairing</CardTitle>
            <CardDescription>
              Open WhatsApp on your phone → Settings → Linked devices → Link a device, then scan
              this QR code.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {qrValue ? (
              <div className="rounded-xl bg-white p-4 shadow-inner">
                <QRCode value={qrValue} size={240} aria-label="WhatsApp pairing QR code" />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed px-10 py-16 text-center text-sm text-muted-foreground">
                {expectingQr || needsQr
                  ? 'Waiting for a fresh QR from Talky… keep this page open.'
                  : 'No QR available yet.'}
              </div>
            )}
            {status?.whatsappConnection != null && (
              <p className="text-xs text-muted-foreground">
                Connection: <code className="text-xs">{status.whatsappConnection}</code>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw />
              Relink session
            </CardTitle>
            <CardDescription>
              Logs out and starts a fresh pairing flow. Scan the QR here or in the terminal.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="button" onClick={runRelink}>
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
            <Button type="button" variant="secondary" onClick={runRepair}>
              Run repair
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
