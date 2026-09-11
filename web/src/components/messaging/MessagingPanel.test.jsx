import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessagingPanel from './MessagingPanel.jsx';
import MessageDock from './MessageDock.jsx';

const mocks = vi.hoisted(() => ({
  user: { id: 'viewer-id', username: 'viewer' },
  messaging: {},
}));

vi.mock('../../hooks/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock('../../hooks/MessagingContext.jsx', () => ({
  useMessaging: () => mocks.messaging,
}));

function conversation(overrides = {}) {
  return {
    id: 'conversation-1',
    state: 'pending',
    requester_id: 'sender-id',
    is_request: true,
    participant: { id: 'sender-id', username: 'sender', display_name: 'Sender', account_type: 'real' },
    unread_count: 1,
    last_message: { text: 'hello' },
    ...overrides,
  };
}

function baseMessaging() {
  return {
    capabilities: { curated_emotes: ['👍'], gifs: { available: false } },
    inbox: [],
    requests: [conversation()],
    unread: { inbox: 0, requests: 1, total: 1 },
    messages: {
      'conversation-1': [{
        id: 'message-1',
        conversation_id: 'conversation-1',
        sender_id: 'sender-id',
        kind: 'text',
        content: { text: '<img src=x onerror=alert(1)>' },
        text: '<img src=x onerror=alert(1)>',
        created_at: '2026-09-11T00:00:00Z',
        can_report: true,
      }],
    },
    historyCursors: {},
    selectedId: 'conversation-1',
    composeUsername: '',
    draft: '',
    setDraft: vi.fn(),
    dockOpen: true,
    setDockOpen: vi.fn(),
    dockMinimized: false,
    setDockMinimized: vi.fn(),
    busy: false,
    error: '',
    selectConversation: vi.fn(),
    loadConversation: vi.fn().mockResolvedValue(null),
    decideRequest: vi.fn(),
    deleteMessage: vi.fn(),
    refreshAll: vi.fn(),
    send: vi.fn(),
  };
}

describe('MessagingPanel', () => {
  beforeEach(() => {
    mocks.user = { id: 'viewer-id', username: 'viewer' };
    mocks.messaging = baseMessaging();
  });

  it('shows incoming request controls and renders message content as plain text', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MessagingPanel /></MemoryRouter>);

    expect(screen.getByRole('button', { name: /requests/i })).toHaveTextContent('1');
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('.sx-message-bubble img')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'ACCEPT' }));
    expect(mocks.messaging.decideRequest).toHaveBeenCalledWith('conversation-1', 'accept');
  });

  it('shows the compact launcher and opens the dock', async () => {
    const user = userEvent.setup();
    mocks.messaging.dockOpen = false;
    render(<MemoryRouter><MessageDock /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Open compact messages' }));
    expect(mocks.messaging.setDockOpen).toHaveBeenCalledWith(true);
    expect(mocks.messaging.loadConversation).toHaveBeenCalledWith('conversation-1');
  });
});
