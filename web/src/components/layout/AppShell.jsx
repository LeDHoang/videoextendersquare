import { Outlet } from 'react-router-dom';
import Nav from './Nav.jsx';
import Sidebar from './Sidebar.jsx';
import { useHealth } from '../../hooks/useHealth.js';
import { useConfig } from '../../hooks/useConfig.js';

export default function AppShell() {
  const health = useHealth();
  const { config, setFalKey, setModels } = useConfig();

  return (
    <div className="sx-shell">
      <Sidebar health={health} config={config} onConfigChange={() => health.refresh()} />
      <main className="sx-main">
        <Outlet />
      </main>
    </div>
  );
}