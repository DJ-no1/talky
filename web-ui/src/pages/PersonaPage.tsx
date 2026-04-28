import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'

export function PersonaPage() {
  const { editingPersona, personaDirty, setEditingPersona, savePersona } = useTalkyConsole()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Persona</h1>
          <p className="text-muted-foreground">
            Edit soul, communication rules, and recent memory (Markdown).
          </p>
        </div>
        <div className="flex items-center gap-3">
          {personaDirty ? (
            <span className="text-sm text-amber-600 dark:text-amber-400">Unsaved changes</span>
          ) : (
            <span className="text-sm text-muted-foreground">Synced from disk</span>
          )}
          <Button type="button" onClick={() => void savePersona()} disabled={!personaDirty}>
            Save
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Soul</CardTitle>
          <CardDescription>
            Written to <code className="text-xs">persona/soul.md</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="soul">Content</Label>
          <Textarea
            id="soul"
            rows={12}
            value={editingPersona.soul}
            onChange={(e) =>
              setEditingPersona({ ...editingPersona, soul: e.target.value })
            }
            className="font-mono text-sm"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Communication rules</CardTitle>
          <CardDescription>
            Written to <code className="text-xs">persona/communication_rules.md</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="rules">Content</Label>
          <Textarea
            id="rules"
            rows={12}
            value={editingPersona.communicationRules}
            onChange={(e) =>
              setEditingPersona({
                ...editingPersona,
                communicationRules: e.target.value,
              })
            }
            className="font-mono text-sm"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent memory</CardTitle>
          <CardDescription>
            Written to <code className="text-xs">persona/recent_memory.md</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="recent">Content</Label>
          <Textarea
            id="recent"
            rows={10}
            value={editingPersona.recentMemory}
            onChange={(e) =>
              setEditingPersona({
                ...editingPersona,
                recentMemory: e.target.value,
              })
            }
            className="font-mono text-sm"
          />
        </CardContent>
      </Card>
    </div>
  )
}
