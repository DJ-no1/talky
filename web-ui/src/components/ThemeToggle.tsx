import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

const items = [
  { value: 'light' as const, label: 'Light', icon: Sun },
  { value: 'dark' as const, label: 'Dark', icon: Moon },
  { value: 'system' as const, label: 'System', icon: Monitor },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => {
      setMounted(true)
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  if (!mounted) {
    return (
      <div className="flex gap-1 px-2 py-2" aria-hidden>
        <div className="size-8 rounded-md border border-transparent" />
        <div className="size-8 rounded-md border border-transparent" />
        <div className="size-8 rounded-md border border-transparent" />
      </div>
    )
  }

  return (
    <div className="flex gap-1 px-2 py-2">
      <span className="sr-only">Theme</span>
      {items.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          type="button"
          variant={theme === value ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8 shrink-0"
          onClick={() => setTheme(value)}
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
        >
          <Icon className="size-4" />
        </Button>
      ))}
    </div>
  )
}
