import { LayoutDashboard, ListTodo, Mail, MessageSquare, ScrollText, Shield, Wrench } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { ThemeToggle } from '@/components/ThemeToggle'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { useTalkyConsole } from '@/context/TalkyConsoleContext'

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/chats', label: 'Chats', icon: MessageSquare },
  { to: '/allowlists', label: 'Allowlists', icon: Shield },
  { to: '/inbox', label: 'Inbox', icon: Mail },
  { to: '/persona', label: 'Persona', icon: ScrollText },
  { to: '/actions', label: 'Actions', icon: Wrench },
] as const

export function ConsoleLayout() {
  const { status, unauthorized } = useTalkyConsole()
  const location = useLocation()

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="flex flex-row items-center gap-2 border-b border-sidebar-border px-2 py-3">
          <SidebarTrigger />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
            <span className="truncate font-semibold">Talky</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {status ? (
                <>
                  <Badge variant="secondary">Port {status.port}</Badge>
                  <Badge variant="outline">{status.status}</Badge>
                </>
              ) : (
                <Badge variant="outline">…</Badge>
              )}
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Console</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map(({ to, label, icon: Icon }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      isActive={location.pathname === to}
                      tooltip={label}
                      render={<NavLink to={to} />}
                    >
                      <Icon />
                      <span>{label}</span>
                      {to === '/inbox' && unauthorized.length > 0 ? (
                        <SidebarMenuBadge>{unauthorized.length}</SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel className="flex items-center gap-2">
              <ListTodo className="size-4 shrink-0" />
              Roadmap
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <p className="px-2 text-xs leading-snug text-muted-foreground">
                SSE auth, QR inline, and typed forms are tracked in FEATURE_REQUESTS.md.
              </p>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="mt-auto border-t border-sidebar-border p-0">
          <ThemeToggle />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
          <span className="font-medium">Talky</span>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
