import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cpu, FolderX, RefreshCw, Stethoscope } from 'lucide-react'
import {QRCode} from 'react-qr-code'
import { toast } from 'sonner'
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'
import type { GeminiModelOption, ModelsPayload, TalkyConfig } from '@/types/api'

const QR_POLL_MS = 1500

export function ActionsPage() {
  const { sessionAction, status, refresh, config } = useTalkyConsole()
  const [fullResetOpen, setFullResetOpen] = useState(false)
  const [fullResetConfirmText, setFullResetConfirmText] = useState('')

  const [geminiModels, setGeminiModels] = useState<GeminiModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [selectedModelId, setSelectedModelId] = useState('')
  const [savingModel, setSavingModel] = useState(false)

  const loadGeminiModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError(null)
    try {
      const res = await fetch('/api/models')
      const data = (await res.json()) as ModelsPayload & { error?: string }
      if (!res.ok) {
        setGeminiModels([])
        setModelsError(data.error ?? `HTTP ${res.status}`)
        return
      }
      const safeModels = Array.isArray(data.models)
        ? data.models
            .filter((m) => Boolean(m && typeof m === 'object'))
            .map((m) => {
              const row = m as Partial<GeminiModelOption>
              const id = typeof row.id === 'string' ? row.id.trim() : ''
              if (!id) return null
              const displayName =
                typeof row.displayName === 'string' && row.displayName.trim()
                  ? row.displayName.trim()
                  : id
              return { id, displayName }
            })
            .filter((m): m is GeminiModelOption => m !== null)
        : []
      setGeminiModels(safeModels)
      if (typeof data.currentModel === 'string' && data.currentModel) {
        setSelectedModelId(data.currentModel)
      }
    } catch (e) {
      console.error('[Talky UI] /api/models', e)
      setGeminiModels([])
      setModelsError(e instanceof Error ? e.message : 'Failed to load models')
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadGeminiModels()
  }, [loadGeminiModels])

  const configModel =
    typeof config?.model === 'string' && config.model.trim() !== '' ? config.model.trim() : ''

  useEffect(() => {
    if (configModel) {
      setSelectedModelId(configModel)
    }
  }, [configModel])

  const modelChoices = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of geminiModels) {
      const id = typeof m.id === 'string' ? m.id.trim() : ''
      if (!id) continue
      const displayName =
        typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : id
      map.set(id, displayName)
    }
    if (selectedModelId && !map.has(selectedModelId)) {
      map.set(selectedModelId, `${selectedModelId} (current)`)
    } else if (configModel && !map.has(configModel)) {
      map.set(configModel, `${configModel} (current)`)
    }
    return [...map.entries()]
      .map(([id, displayName]) => ({ id, displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
  }, [geminiModels, selectedModelId, configModel])
  const selectValue = modelChoices.some((m) => m.id === selectedModelId) ? selectedModelId : undefined

  const applyGeminiModel = async () => {
    if (!config || !selectedModelId) {
      toast.error('Pick a model first')
      return
    }
    setSavingModel(true)
    try {
      const body: TalkyConfig = { ...config, model: selectedModelId }
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(`${res.status}`)
      }
      toast.success(`Gemini model set to ${selectedModelId}`)
      void refresh()
      void loadGeminiModels()
    } catch (e) {
      console.error('[Talky UI] save model', e)
      toast.error('Could not save model — is Talky running?')
    } finally {
      setSavingModel(false)
    }
  }

  const qrValue = status?.whatsappQr ?? null
  const waConnected = status?.whatsappConnected === true
  /** Any time Talky isn't linked to WhatsApp, show pairing (survives page refresh mid-relink). */
  const showQrUi = status !== null && !waConnected

  useEffect(() => {
    if (!showQrUi) return
    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, QR_POLL_MS)
    return () => window.clearInterval(id)
  }, [showQrUi, refresh])

  const runRelink = () => {
    void sessionAction('relink')
  }

  const runRepair = () => {
    void sessionAction('repair')
  }

  const runFullResetRelink = () => {
    if (fullResetConfirmText.trim().toUpperCase() !== 'RESET') return
    void sessionAction('full-relink')
    setFullResetConfirmText('')
    setFullResetOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <AlertDialog
        open={fullResetOpen}
        onOpenChange={(open: boolean) => {
          setFullResetOpen(open)
          if (!open) setFullResetConfirmText('')
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Factory reset Talky local state?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes local <code className="font-mono text-xs">wa_auth/</code>,{' '}
              <code className="font-mono text-xs">data/</code>,{' '}
              <code className="font-mono text-xs">persona/</code>, and{' '}
              <code className="font-mono text-xs">config.yaml</code>. Inbox/chat history snapshots,
              memory DB/logs, and persona files are wiped. Talky then restarts and asks for a fresh
              WhatsApp QR.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-1">
            <p className="text-sm text-muted-foreground">
              Type <code className="font-mono text-xs">RESET</code> to confirm.
            </p>
            <Input
              value={fullResetConfirmText}
              onChange={(event) => setFullResetConfirmText(event.target.value)}
              placeholder="Type RESET"
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={fullResetConfirmText.trim().toUpperCase() !== 'RESET'}
              onClick={(e) => {
                e.preventDefault()
                runFullResetRelink()
              }}
            >
              Delete all local data & restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
        <p className="text-muted-foreground">
          Gemini model selection and WhatsApp session tools — CLI parity for{' '}
          <code className="text-xs">relink</code>, repair, and full auth reset (
          <code className="text-xs">bun run relink</code>).
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
              <div className="flex w-full flex-col items-center gap-3">
                <div className="rounded-xl border bg-white p-4 shadow-sm">
                  <QRCode value={qrValue} size={220} />
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  Scan this QR from WhatsApp. The same QR is also printed in the Talky terminal.
                </p>
              </div>
            ) : (
              <div className="flex w-full flex-col items-center gap-3">
                {status?.whatsappUiNote ? (
                  <p
                    className={
                      status.whatsappUiNote.startsWith('Reconnecting after')
                        ? 'max-w-md text-center text-sm text-muted-foreground'
                        : 'max-w-md text-center text-sm text-destructive'
                    }
                  >
                    {status.whatsappUiNote}
                  </p>
                ) : null}
                <div className="rounded-xl border border-dashed px-10 py-16 text-center text-sm text-muted-foreground">
                  {(() => {
                    const note = status?.whatsappUiNote
                    const blocking =
                      note &&
                      (note.includes('connection replaced') ||
                        note.includes('Bad session') ||
                        note.includes('Reconnect failed') ||
                        note.includes('Logged out from WhatsApp'))
                    if (blocking) {
                      return 'Pairing is paused until the issue above is fixed. Check the Talky terminal for details.'
                    }
                    return status?.whatsappConnection === 'connecting'
                      ? 'Connecting… Talky will show a QR here when it is ready.'
                      : 'Waiting for a fresh QR from Talky… keep this page open.'
                  })()}
                </div>
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

      <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Cpu />
              Gemini chat model
            </CardTitle>
            <CardDescription>
              Names come from Google&apos;s{' '}
              <code className="text-xs">generativelanguage.googleapis.com/v1beta/models</code> list for
              your API key (models that support{' '}
              <code className="text-xs">generateContent</code>).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {modelsError ? (
              <p className="text-sm text-destructive">{modelsError}</p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {modelChoices.length > 0 ? (
                <Select value={selectValue} onValueChange={(next) => setSelectedModelId(next ?? '')}>
                  <SelectTrigger className="w-full min-w-0 sm:max-w-md">
                    <SelectValue placeholder={modelsLoading ? 'Loading models…' : 'Choose model'} />
                  </SelectTrigger>
                  <SelectContent>
                    {modelChoices.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="truncate">{m.displayName}</span>
                        <span className="text-muted-foreground font-mono text-xs opacity-80">{m.id}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="w-full rounded-md border px-3 py-2 text-sm text-muted-foreground sm:max-w-md">
                  {modelsLoading ? 'Loading models…' : 'No models available for this API key yet.'}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={modelsLoading}
                onClick={() => void loadGeminiModels()}
              >
                Refresh list
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Saves to <code className="text-xs">config.yaml</code> as{' '}
              <code className="text-xs">model</code> and reloads the running agent.
            </p>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button type="button" disabled={savingModel || !selectedModelId} onClick={() => void applyGeminiModel()}>
              {savingModel ? 'Saving…' : 'Apply model'}
            </Button>
          </CardFooter>
        </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw />
              Relink session
            </CardTitle>
            <CardDescription>
              Clears <code className="text-xs">wa_auth/</code> and reconnects — same as{' '}
              <code className="text-xs">bun run relink</code> while the bot stays running. A QR for
              new registration appears here (and as ASCII in the terminal).
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
        <Card className="border-destructive/25 md:col-span-2 xl:col-span-1">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FolderX />
              Full reset (factory wipe)
            </CardTitle>
            <CardDescription>
              Wipes local auth, inbox snapshots, memory/log data, persona files, and config, then
              restarts Talky with a new QR flow.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="button" variant="destructive" onClick={() => setFullResetOpen(true)}>
              Factory reset & restart…
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
