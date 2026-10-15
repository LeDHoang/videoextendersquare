import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessagesPage from './MessagesPage.jsx';

const mocks = vi.hoisted(() => ({
  messaging: {},
  panelProps: null,
}));

vi.mock('../hooks/MessagingContext.jsx', () => ({ useMessaging: () => mocks.messaging }));
vi.mock('../components/messaging/MessagingPanel.jsx', () => ({
  default: (props) => {
    mocks.panelProps = props;
    return <div data-testid="panel" />;
  },
}));

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/messages/:conversationId" element={<MessagesPage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

describe('MessagesPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.panelProps = null;
    mocks.messaging = {
      unread: { inbox: 2, requests: 1, total: 3 },
      selectConversation: vi.fn(),
      composeTo: vi.fn(),
    };
  });

  it('shows the live unread, request and security telemetry', () => {
    renderAt('/messages');
    const totals = screen.getByLabelText('Message totals');
    expect(totals).toHaveTextContent('UNREAD 3');
    expect(totals).toHaveTextContent('REQUESTS 1');
    expect(totals).toHaveTextContent('NOT END-TO-END');
    expect(screen.getByRole('heading', { name: 'MESSAGES' })).toBeInTheDocument();
    expect(screen.getByTestId('panel')).toBeInTheDocument();
  });

  it('opens the conversation named in the URL', () => {
    renderAt('/messages/conv%20one');
    expect(mocks.messaging.selectConversation).toHaveBeenCalledWith('conv one');
    expect(mocks.messaging.composeTo).not.toHaveBeenCalled();
  });

  it('starts a compose for ?user=', () => {
    renderAt('/messages?user=kira_vr');
    expect(mocks.messaging.composeTo).toHaveBeenCalledWith('kira_vr');
    expect(mocks.messaging.selectConversation).not.toHaveBeenCalled();
  });

  it('does nothing extra for the bare inbox', () => {
    renderAt('/messages');
    expect(mocks.messaging.selectConversation).not.toHaveBeenCalled();
    expect(mocks.messaging.composeTo).not.toHaveBeenCalled();
  });

  it('routes selection changes to /messages/:id and clears back to /messages', () => {
    renderAt('/messages?user=kira_vr');
    act(() => mocks.panelProps.onConversationRoute('abc 1'));
    expect(screen.getByTestId('where')).toHaveTextContent('/messages/abc%201');
    act(() => mocks.panelProps.onConversationRoute(null));
    expect(screen.getByTestId('where').textContent).toBe('/messages');
  });
});
