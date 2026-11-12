import { BrowserRouter, Route, Routes } from 'react-router';
import type { ControlClient } from '../api/client.ts';
import { ConsoleProvider } from './context.tsx';
import { Shell } from './Shell.tsx';
import { ReleasesPage } from '../pages/ReleasesPage.tsx';
import { GateRunsPage } from '../pages/GateRunsPage.tsx';
import { GateRunNewPage } from '../pages/GateRunNewPage.tsx';
import { GateRunPage } from '../pages/GateRunPage.tsx';
import { CaseRunPage } from '../pages/CaseRunPage.tsx';
import { OperationsPage } from '../pages/OperationsPage.tsx';
import { OperationPage } from '../pages/OperationPage.tsx';
import { RegressionsPage } from '../pages/RegressionsPage.tsx';
import { ImportPage } from '../pages/ImportPage.tsx';
import { SettingsPage } from '../pages/SettingsPage.tsx';
import { ConnectPage, NotFoundPage, ProjectsPage } from '../pages/MiscPages.tsx';

export const ROUTES = [
  '/',
  '/connect',
  '/settings',
  '/projects/:projectId/releases',
  '/projects/:projectId/gate-runs',
  '/projects/:projectId/gate-runs/new',
  '/projects/:projectId/gate-runs/:gateRunId',
  '/projects/:projectId/gate-runs/:gateRunId/cases/:caseRunId',
  '/projects/:projectId/operations',
  '/projects/:projectId/operations/:runOperationId',
  '/projects/:projectId/operations/:runOperationId/evidence/:evidenceId',
  '/projects/:projectId/regressions',
  '/projects/:projectId/regressions/:importId',
] as const;

export function App({ client }: { client: ControlClient }) {
  return (
    <ConsoleProvider client={client}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/connect" element={<ConnectPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/projects/:projectId/releases" element={<ReleasesPage />} />
            <Route path="/projects/:projectId/gate-runs" element={<GateRunsPage />} />
            <Route path="/projects/:projectId/gate-runs/new" element={<GateRunNewPage />} />
            <Route path="/projects/:projectId/gate-runs/:gateRunId" element={<GateRunPage />} />
            <Route
              path="/projects/:projectId/gate-runs/:gateRunId/cases/:caseRunId"
              element={<CaseRunPage />}
            />
            <Route path="/projects/:projectId/operations" element={<OperationsPage />} />
            <Route path="/projects/:projectId/operations/:runOperationId" element={<OperationPage />} />
            <Route
              path="/projects/:projectId/operations/:runOperationId/evidence/:evidenceId"
              element={<OperationPage />}
            />
            <Route path="/projects/:projectId/regressions" element={<RegressionsPage />} />
            <Route path="/projects/:projectId/regressions/:importId" element={<ImportPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </ConsoleProvider>
  );
}
