import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import ErrorBoundary from '../ErrorBoundary.jsx';
import { HealthProvider, useHealthContext } from '../../hooks/HealthContext.jsx';
import { ConfigProvider, useConfigContext } from '../../hooks/ConfigContext.jsx';

function Shell() {
  const health = useHealthContext();
  const { config, setFalKey, setModels } = useConfigContext();
  const location = useLocation();

  return (
    <div className="sx-shell">
      <Sidebar health={health} config={config} setFalKey={setFalKey} setModels={setModels} />
      <main className="sx-main">
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

export default function AppShell() {
  return (
    <HealthProvider>
      <ConfigProvider>
        <Shell />
      </ConfigProvider>
    </HealthProvider>
  );
}