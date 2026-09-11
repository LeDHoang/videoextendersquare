import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const MessagingContext = createContext(null);
const EVENT_TYPES = [
  'message.created',
  'message.deleted',
  'conversation.read',
  'request.accepted',
  'request.declined',
  'conversation.blocked',
];

function readStored(key, fallback) {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function clientId(prefix = 'message') {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}:${random}`.slice(0, 64);
}

export function MessagingProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const draftStorageKey = `echo:message-drafts:${user?.id || 'anonymous'}`;
  const [capabilities, setCapabilities] = useState(null);
  const [inbox, setInbox] = useState([]);
  const [requests, setRequests] = useState([]);
  const [unread, setUnread] = useState({ inbox: 0, requests: 0, total: 0 });
  const [messages, setMessages] = useState({});
  const [historyCursors, setHistoryCursors] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [composeUsername, setComposeUsername] = useState('');
  const [drafts, setDrafts] = useState(() => readStored(draftStorageKey, {}));
  const [dockOpen, setDockOpen] = useState(() => readStored('echo:message-dock-open', false));
  const [dockMinimized, setDockMinimized] = useState(false);
  const [shareTarget, setShareTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eventCursor = useRef(0);
  const refreshTimer = useRef(null);
  const conversationVisible = location.pathname.startsWith('/messages')
    || (dockOpen && !dockMinimized);

  const loadCapabilities = useCallback(async () => {
    try {
      setCapabilities(await api.get('/api/messages/capabilities'));
    } catch {
      setCapabilities(null);
    }
  }, []);

  const loadBox = useCallback(async (box) => {
    if (!user) return null;
    const result = await api.get('/api/messages/bootstrap', { box, limit: 50 });
    if (box === 'requests') setRequests(result.conversations || []);
    else setInbox(result.conversations || []);
    setUnread(result.unread || { inbox: 0, requests: 0, total: 0 });
    eventCursor.current = Math.max(eventCursor.current, Number(result.event_cursor) || 0);
    return result;
  }, [user]);

  const refreshAll = useCallback(async () => {
    if (!user) return;
    try {
      await Promise.all([loadBox('inbox'), loadBox('requests')]);
    } catch (requestError) {
      setError(requestError.message || 'Could not refresh messages.');
    }
  }, [loadBox, user]);

  const loadConversation = useCallback(async (conversationId, options = {}) => {
    if (!conversationId || !user) return null;
    const params = { limit: 60 };
    if (options.before) params.before = options.before;
    const result = await api.get(`/api/messages/conversations/${encodeURIComponent(conversationId)}/messages`, params);
    setMessages((current) => ({
      ...current,
      [conversationId]: options.before
        ? [...(result.messages || []), ...(current[conversationId] || [])]
        : result.messages || [],
    }));
    setHistoryCursors((current) => ({ ...current, [conversationId]: result.next_before || null }));
    const latest = result.messages?.[result.messages.length - 1];
    if (options.markRead !== false && latest && latest.sender_id !== user.id) {
      api.post(`/api/messages/conversations/${encodeURIComponent(conversationId)}/read`, { message_id: latest.id })
        .then(() => refreshAll())
        .catch(() => {});
    }
    return result;
  }, [refreshAll, user]);

  useEffect(() => {
    loadCapabilities();
  }, [loadCapabilities]);

  useEffect(() => {
    if (!user) {
      setInbox([]);
      setRequests([]);
      setUnread({ inbox: 0, requests: 0, total: 0 });
      setMessages({});
      setSelectedId(null);
      return undefined;
    }
    try {
      const pendingShare = JSON.parse(sessionStorage.getItem('echo:resume-share') || 'null');
      if (pendingShare?.post_id && Date.now() - Number(pendingShare.created_at || 0) < 10 * 60 * 1000) {
        setShareTarget({ post_id: pendingShare.post_id });
      }
      sessionStorage.removeItem('echo:resume-share');
    } catch {
      // Resume is best effort.
    }
    refreshAll();
    return undefined;
  }, [refreshAll, user]);

  useEffect(() => {
    if (!user || typeof EventSource === 'undefined') return undefined;
    let source;
    let reconnectTimer;
    let stopped = false;
    const connect = () => {
      source = new EventSource(`/api/messages/events?after=${eventCursor.current}`, { withCredentials: true });
      const receive = (event) => {
        if (event.lastEventId) eventCursor.current = Math.max(eventCursor.current, Number(event.lastEventId) || 0);
        let payload = null;
        try {
          payload = JSON.parse(event.data || 'null');
        } catch {
          // A malformed event still triggers a safe list refresh.
        }
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          refreshAll();
          if (selectedId && (!payload?.conversation_id || payload.conversation_id === selectedId)) {
            loadConversation(selectedId, {
              markRead: conversationVisible && document.visibilityState !== 'hidden',
            }).catch(() => {});
          }
        }, 80);
      };
      EVENT_TYPES.forEach((type) => source.addEventListener(type, receive));
      source.onerror = () => {
        source.close();
        if (!stopped) reconnectTimer = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(refreshTimer.current);
      source?.close();
    };
  }, [conversationVisible, loadConversation, refreshAll, selectedId, user]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && conversationVisible && selectedId) {
        loadConversation(selectedId).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [conversationVisible, loadConversation, selectedId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(draftStorageKey, JSON.stringify(drafts));
    } catch {
      // Draft persistence is best effort.
    }
  }, [draftStorageKey, drafts]);

  useEffect(() => {
    try {
      sessionStorage.setItem('echo:message-dock-open', JSON.stringify(dockOpen));
    } catch {
      // Dock state persistence is best effort.
    }
  }, [dockOpen]);

  const selectConversation = useCallback((conversationId, { dock = false } = {}) => {
    setSelectedId(conversationId || null);
    setComposeUsername('');
    if (dock) {
      setDockOpen(true);
      setDockMinimized(false);
    }
    if (conversationId) loadConversation(conversationId).catch((requestError) => {
      setError(requestError.message || 'Could not load conversation.');
    });
  }, [loadConversation]);

  const composeTo = useCallback((username, { dock = false } = {}) => {
    setSelectedId(null);
    setComposeUsername(username || '');
    if (dock) {
      setDockOpen(true);
      setDockMinimized(false);
    }
  }, []);

  const draftKey = selectedId ? `conversation:${selectedId}` : composeUsername ? `user:${composeUsername}` : 'new';
  const draft = drafts[draftKey] || '';
  const setDraft = useCallback((value) => {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  }, [draftKey]);

  const send = useCallback(async (payload) => {
    if (!selectedId && !composeUsername) throw new Error('Choose someone to message.');
    const outgoingId = payload.client_id || clientId(payload.kind || 'message');
    const optimistic = {
      id: `pending:${outgoingId}`,
      conversation_id: selectedId,
      sender_id: user.id,
      kind: payload.kind || 'text',
      content: payload.kind === 'emote' ? { emote: payload.emote } : { text: payload.text || '' },
      text: payload.emote || payload.text || '',
      created_at: new Date().toISOString(),
      pending: true,
    };
    const optimisticKey = selectedId || `user:${composeUsername}`;
    setMessages((current) => ({
      ...current,
      [optimisticKey]: [...(current[optimisticKey] || []), optimistic],
    }));
    setBusy(true);
    setError('');
    try {
      const body = { ...payload, client_id: outgoingId };
      const result = selectedId
        ? await api.post(`/api/messages/conversations/${encodeURIComponent(selectedId)}/messages`, body)
        : await api.post('/api/messages/direct', { ...body, username: composeUsername });
      const conversationId = result.conversation?.id || selectedId;
      setMessages((current) => {
        const source = current[optimisticKey] || [];
        const reconciled = source.filter((item) => item.id !== optimistic.id);
        const alreadyPresent = reconciled.some((item) => item.id === result.message.id);
        return {
          ...current,
          [optimisticKey]: optimisticKey === conversationId ? reconciled : [],
          [conversationId]: alreadyPresent ? reconciled : [...(current[conversationId] || []).filter((item) => item.id !== optimistic.id), result.message],
        };
      });
      setSelectedId(conversationId);
      setComposeUsername('');
      setDrafts((current) => ({ ...current, [draftKey]: '' }));
      await refreshAll();
      return result;
    } catch (requestError) {
      setMessages((current) => ({
        ...current,
        [optimisticKey]: (current[optimisticKey] || []).filter((item) => item.id !== optimistic.id),
      }));
      setError(requestError.message || 'Could not send message.');
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [composeUsername, draftKey, refreshAll, selectedId, user]);

  const decideRequest = useCallback(async (conversationId, decision) => {
    await api.post(`/api/messages/conversations/${encodeURIComponent(conversationId)}/${decision}`, {});
    await refreshAll();
    await loadConversation(conversationId);
  }, [loadConversation, refreshAll]);

  const deleteMessage = useCallback(async (messageId, conversationId) => {
    await api.delete(`/api/messages/${encodeURIComponent(messageId)}`);
    await loadConversation(conversationId);
    await refreshAll();
  }, [loadConversation, refreshAll]);

  const value = useMemo(() => ({
    capabilities,
    inbox,
    requests,
    unread,
    messages,
    historyCursors,
    selectedId,
    composeUsername,
    draft,
    setDraft,
    dockOpen,
    setDockOpen,
    dockMinimized,
    setDockMinimized,
    shareTarget,
    openShare: setShareTarget,
    closeShare: () => setShareTarget(null),
    busy,
    error,
    setError,
    refreshAll,
    loadBox,
    loadConversation,
    selectConversation,
    composeTo,
    send,
    decideRequest,
    deleteMessage,
  }), [
    capabilities, inbox, requests, unread, messages, historyCursors, selectedId,
    composeUsername, draft, setDraft, dockOpen, dockMinimized, shareTarget, busy,
    error, refreshAll, loadBox, loadConversation, selectConversation, composeTo,
    send, decideRequest, deleteMessage,
  ]);

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

export function useMessaging() {
  const value = useContext(MessagingContext);
  if (!value) throw new Error('useMessaging must be used inside MessagingProvider');
  return value;
}

export { clientId };
