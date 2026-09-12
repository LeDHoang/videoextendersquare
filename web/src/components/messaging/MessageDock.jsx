import { useNavigate } from 'react-router-dom';
import { useMessaging } from '../../hooks/MessagingContext.jsx';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { IndustrialMessageIcon } from '../icons/index.jsx';
import MessagingPanel from './MessagingPanel.jsx';

export default function MessageDock() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const messaging = useMessaging();
  if (!user) return null;
  if (!messaging.dockOpen) {
    return (
      <button
        type="button"
        className="sx-message-launcher"
        onClick={() => {
          messaging.setDockOpen(true);
          if (messaging.selectedId) messaging.loadConversation(messaging.selectedId).catch(() => {});
        }}
        aria-label="Open compact messages"
      >
        <IndustrialMessageIcon className="sx-message-launcher-icon" />
        MESSAGE{messaging.unread.total ? <span>{messaging.unread.total}</span> : null}
      </button>
    );
  }
  return (
    <section className={`sx-message-dock ${messaging.dockMinimized ? 'sx-minimized' : ''}`} aria-label="Compact messages">
      <header>
        <button type="button" className="sx-message-dock-title" onClick={() => navigate(messaging.selectedId ? `/messages/${messaging.selectedId}` : '/messages')}><IndustrialMessageIcon className="sx-message-dock-icon" />MESSAGES</button>
        <span>{messaging.unread.total ? `${messaging.unread.total} UNREAD` : 'LIVE'}</span>
        <button
          type="button"
          onClick={() => {
            const expanding = messaging.dockMinimized;
            messaging.setDockMinimized(!messaging.dockMinimized);
            if (expanding && messaging.selectedId) messaging.loadConversation(messaging.selectedId).catch(() => {});
          }}
          aria-label={messaging.dockMinimized ? 'Expand messages' : 'Minimize messages'}
        >{messaging.dockMinimized ? '□' : '—'}</button>
        <button type="button" onClick={() => messaging.setDockOpen(false)} aria-label="Close messages">×</button>
      </header>
      {!messaging.dockMinimized ? <MessagingPanel compact /> : null}
    </section>
  );
}
