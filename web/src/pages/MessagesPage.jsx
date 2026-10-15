import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import MessagingPanel from '../components/messaging/MessagingPanel.jsx';
import { IndustrialMessageIcon } from '../components/icons/index.jsx';
import { useMessaging } from '../hooks/MessagingContext.jsx';

/*
 * Direct messages. Owner-only by construction: the route is wrapped in
 * <RequireAuth> and every request is a /api/messages endpoint the server
 * resolves from the session cookie; a conversation id from the URL that does
 * not belong to the viewer is rejected by the server (404).
 */
export default function MessagesPage() {
  const { conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const messaging = useMessaging();

  useEffect(() => {
    if (conversationId) messaging.selectConversation(conversationId);
    else if (searchParams.get('user')) messaging.composeTo(searchParams.get('user'));
  }, [conversationId, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const route = (id) => navigate(id ? `/messages/${encodeURIComponent(id)}` : '/messages', { replace: true });

  return (
    <div className="sx-messages-page">
      <header className="sx-mx-head">
        <div className="sx-mx-title">
          <span className="sx-mx-icon" aria-hidden="true"><IndustrialMessageIcon className="sx-hero-icon-svg" /></span>
          <div>
            <h1>MESSAGES</h1>
            <div className="sx-mx-kicker">ECHO · DIRECT CONVERSATIONS</div>
          </div>
        </div>
        <div className="sx-mx-telemetry" aria-label="Message totals">
          <span>UNREAD <strong className={messaging.unread.total ? 'sx-hot' : ''}>{messaging.unread.total}</strong></span>
          <i aria-hidden="true" />
          <span>REQUESTS <strong>{messaging.unread.requests}</strong></span>
          <i aria-hidden="true" />
          <span title="Messages are encrypted on the server, not end-to-end">SECURITY <strong>NOT END-TO-END</strong></span>
        </div>
      </header>
      <MessagingPanel onConversationRoute={route} />
    </div>
  );
}
