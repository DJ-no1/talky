import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cpu, RefreshCw, Stethoscope } from 'lucide-react'
import QRCode from 'react-qr-code'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
  const [expectingQr, setExpectingQr] = useState(false)

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
      setGeminiModels(Array.isArray(data.models) ? data.models : [])
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
      map.set(m.id, m.displayName)
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
          Gemini model selection, WhatsApp session maintenance — same session endpoints as CLI{' '}
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
                  ? status?.whatsappConnection === 'connecting'
                    ? 'Connecting… Talky will show a QR here when it is ready.'
                    : 'Waiting for a fresh QR from Talky… keep this page open.'
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
              <Select
                value={selectedModelId || undefined}
                onValueChange={(next) => setSelectedModelId(next ?? '')}
              >
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
