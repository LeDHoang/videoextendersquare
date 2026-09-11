import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import MessagingPanel from '../components/messaging/MessagingPanel.jsx';
import { Hero } from '../components/ui/primitives.jsx';
import { useMessaging } from '../hooks/MessagingContext.jsx';

export default function MessagesPage() {
  const { conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const messaging = useMessaging();

  useEffect(() => {
    if (conversationId) messaging.selectConversation(conversationId);
    else if (searchParams.get('user')) messaging.composeTo(searchParams.get('user'));
  }, [conversationId, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sx-messages-page">
      <Hero title="MESSAGES" kicker="ECHO · ENCRYPTED AT REST · DIRECT CONVERSATIONS">
        <div className="sx-stats-pill">
          <span>UNREAD: <strong>{messaging.unread.total}</strong></span>
          <span>REQUESTS: <strong>{messaging.unread.requests}</strong></span>
          <span>SECURITY: <strong>NOT END-TO-END</strong></span>
        </div>
      </Hero>
      <MessagingPanel onConversationRoute={(id) => navigate(`/messages/${encodeURIComponent(id)}`, { replace: true })} />
    </div>
  );
}
