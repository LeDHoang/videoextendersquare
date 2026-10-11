import { useNavigate } from 'react-router-dom';
import { useMessaging } from '../../hooks/MessagingContext.jsx';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { IndustrialMessageIcon } from '../icons/index.jsx';
import MessagingPanel from './MessagingPanel.jsx';

const GLYPH_PATHS = {
  minimize: 'M5 12h14',
  expand: 'M5 5h14v14H5z',
  close: 'M6 6l12 12M18 6L6 18',
};

function DockGlyph({ kind }) {
  return (
    <svg className="sx-message-dock-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="square" aria-hidden="true">
      <path d={GLYPH_PATHS[kind]} />
    </svg>
  );
}

export default function MessageDock() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const messaging = useMessaging();
  if (!user) return null;
  const unread = messaging.unread.total;
  if (!messaging.dockOpen) {
    return (
      <button
        type="button"
        className="sx-message-launcher"
        onClick={() => {
          messaging.setDockOpen(true);
          if (messaging.selectedId) messaging.loadConversation(messaging.selectedId).catch(() => {});
        }}
        aria-label={unread ? `Open compact messages, ${unread} unread` : 'Open compact messages'}
      >
        <IndustrialMessageIcon className="sx-message-launcher-icon" />
        MESSAGE{unread ? <span>{unread > 99 ? '99+' : unread}</span> : null}
      </button>
    );
  }
  return (
    <section className={`sx-message-dock ${messaging.dockMinimized ? 'sx-minimized' : ''}`} aria-label="Compact messages">
      <header>
        <button
          type="button"
          className="sx-message-dock-title"
          title="Open the full messages page"
          onClick={() => navigate(messaging.selectedId ? `/messages/${encodeURIComponent(messaging.selectedId)}` : '/messages')}
        >
          <IndustrialMessageIcon className="sx-message-dock-icon" />MESSAGES
        </button>
        {unread ? <span className="sx-message-dock-status sx-hot">{unread} UNREAD</span> : null}
        <button
          type="button"
          onClick={() => {
            const expanding = messaging.dockMinimized;
            messaging.setDockMinimized(!messaging.dockMinimized);
            if (expanding && messaging.selectedId) messaging.loadConversation(messaging.selectedId).catch(() => {});
          }}
          aria-label={messaging.dockMinimized ? 'Expand messages' : 'Minimize messages'}
        >
          <DockGlyph kind={messaging.dockMinimized ? 'expand' : 'minimize'} />
        </button>
        <button type="button" onClick={() => messaging.setDockOpen(false)} aria-label="Close messages">
          <DockGlyph kind="close" />
        </button>
      </header>
      {!messaging.dockMinimized ? <MessagingPanel compact /> : null}
    </section>
  );
}
