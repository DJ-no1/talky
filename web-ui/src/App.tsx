import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ConsoleLayout } from '@/components/layout/ConsoleLayout'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TalkyConsoleProvider } from '@/context/TalkyConsoleContext'
import { ActionsPage } from '@/pages/ActionsPage'
import { AllowlistsPage } from '@/pages/AllowlistsPage'
import { ChatsPage } from '@/pages/ChatsPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { InboxPage } from '@/pages/InboxPage'
import { PersonaPage } from '@/pages/PersonaPage'

function App() {
  return (
    <TooltipProvider>
      <TalkyConsoleProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<ConsoleLayout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="chats" element={<ChatsPage />} />
              <Route path="allowlists" element={<AllowlistsPage />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="persona" element={<PersonaPage />} />
              <Route path="actions" element={<ActionsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="top-right" richColors closeButton />
      </TalkyConsoleProvider>
    </TooltipProvider>
  )
}

export default App
