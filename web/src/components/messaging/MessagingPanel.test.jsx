import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessagingPanel from './MessagingPanel.jsx';
import MessageDock from './MessageDock.jsx';

const mocks = vi.hoisted(() => ({
  user: { id: 'viewer-id', username: 'viewer' },
  messaging: {},
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../hooks/AuthContext.jsx', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('../../hooks/MessagingContext.jsx', () => ({
  useMessaging: () => mocks.messaging,
  clientId: (prefix) => `${prefix}:test`,
}));

function conversation(overrides = {}) {
  return {
    id: 'conversation-1',
    state: 'pending',
    requester_id: 'sender-id',
    is_request: true,
    can_message: true,
    participant: { id: 'sender-id', username: 'sender', display_name: 'Sender', account_type: 'real' },
    unread_count: 1,
    last_message: { text: 'hello', kind: 'text', sender_id: 'sender-id' },
    updated_at: '2026-09-11T00:00:00Z',
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: 'message-1',
    conversation_id: 'conversation-1',
    sender_id: 'sender-id',
    kind: 'text',
    content: { text: 'hello there' },
    text: 'hello there',
    created_at: '2026-09-11T10:00:00Z',
    can_report: true,
    ...overrides,
  };
}

function baseMessaging() {
  return {
    capabilities: { curated_emotes: ['👍', '🔥'], gifs: { available: false } },
    inbox: [],
    requests: [conversation()],
    unread: { inbox: 0, requests: 1, total: 1 },
    messages: {
      'conversation-1': [message({ content: { text: '<img src=x onerror=alert(1)>' }, text: '<img src=x onerror=alert(1)>' })],
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
    setError: vi.fn(),
    selectConversation: vi.fn(),
    composeTo: vi.fn(),
    loadConversation: vi.fn().mockResolvedValue(null),
    decideRequest: vi.fn().mockResolvedValue(null),
    deleteMessage: vi.fn().mockResolvedValue(null),
    refreshAll: vi.fn().mockResolvedValue(null),
    send: vi.fn().mockResolvedValue({ conversation: { id: 'conversation-1' } }),
  };
}

function activeConversation(overrides = {}) {
  return conversation({ state: 'active', is_request: false, requester_id: 'viewer-id', unread_count: 0, ...overrides });
}

function renderPanel(props = {}) {
  return render(<MemoryRouter><MessagingPanel {...props} /></MemoryRouter>);
}

describe('MessagingPanel', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.user = { id: 'viewer-id', username: 'viewer' };
    mocks.messaging = baseMessaging();
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
  });

  describe('conversation list', () => {
    it('shows incoming request controls and renders message content as plain text', async () => {
      const user = userEvent.setup();
      renderPanel();

      expect(screen.getByRole('tab', { name: /requests/i })).toHaveTextContent('1');
      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
      expect(document.querySelector('.sx-message-bubble img')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'ACCEPT' }));
      expect(mocks.messaging.decideRequest).toHaveBeenCalledWith('conversation-1', 'accept');
    });

    it('switches between inbox and requests with proper tab semantics', async () => {
      const user = userEvent.setup();
      mocks.messaging.selectedId = null;
      mocks.messaging.inbox = [activeConversation({ id: 'c2', participant: { id: 'p2', username: 'kira_vr', display_name: 'Kira', account_type: 'real' } })];
      renderPanel();
      expect(screen.getByRole('tab', { name: /requests/i })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: /inbox/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Kira')).toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: /requests/i }));
      expect(screen.getByText('Sender')).toBeInTheDocument();
      expect(screen.queryByText('Kira')).not.toBeInTheDocument();
    });

    it('follows the open conversation to the box it lives in', () => {
      mocks.messaging.inbox = [activeConversation({ id: 'c2' })];
      mocks.messaging.selectedId = 'c2';
      renderPanel();
      expect(screen.getByRole('tab', { name: /inbox/i })).toHaveAttribute('aria-selected', 'true');
      cleanup();
      mocks.messaging.selectedId = 'conversation-1';
      renderPanel();
      expect(screen.getByRole('tab', { name: /requests/i })).toHaveAttribute('aria-selected', 'true');
    });

    it('shows empty states per box', async () => {
      const user = userEvent.setup();
      mocks.messaging.requests = [];
      mocks.messaging.selectedId = null;
      renderPanel();
      expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: /requests/i }));
      expect(screen.getByText('No message requests.')).toBeInTheDocument();
      expect(screen.getByText('NO CONVERSATION SELECTED')).toBeInTheDocument();
    });

    it('filters conversations by handle, name and message text', async () => {
      const user = userEvent.setup();
      mocks.messaging.requests = [];
      mocks.messaging.selectedId = null;
      mocks.messaging.inbox = [
        activeConversation({ id: 'a', participant: { id: 'pa', username: 'kira_vr', display_name: 'Kira', account_type: 'real' }, last_message: { text: 'spatial outpaint', kind: 'text', sender_id: 'pa' } }),
        activeConversation({ id: 'b', participant: { id: 'pb', username: 'echodev', display_name: 'EchoDev', account_type: 'real' }, last_message: { text: 'pipeline updated', kind: 'text', sender_id: 'pb' } }),
      ];
      renderPanel();
      const filter = screen.getByLabelText('Filter conversations');
      await user.type(filter, '@kira');
      expect(screen.getByText('Kira')).toBeInTheDocument();
      expect(screen.queryByText('EchoDev')).not.toBeInTheDocument();
      await user.clear(filter);
      await user.type(filter, 'pipeline');
      expect(screen.getByText('EchoDev')).toBeInTheDocument();
      await user.clear(filter);
      await user.type(filter, 'zzzz');
      expect(screen.getByText('No conversations match your filter.')).toBeInTheDocument();
    });

    it('marks the selected row and previews your own message with "You:"', () => {
      mocks.messaging.requests = [];
      mocks.messaging.inbox = [activeConversation({ last_message: { text: 'sent it', kind: 'text', sender_id: 'viewer-id' } })];
      renderPanel();
      const row = screen.getByRole('button', { name: /Sender/ });
      expect(row).toHaveAttribute('aria-current', 'true');
      expect(within(row).getByText('You: sent it')).toBeInTheDocument();
    });

    it('selects a conversation, flagging dock mode when compact', async () => {
      const user = userEvent.setup();
      const onRoute = vi.fn();
      mocks.messaging.requests = [];
      mocks.messaging.selectedId = null;
      mocks.messaging.inbox = [activeConversation()];
      renderPanel({ compact: true, onConversationRoute: onRoute });
      await user.click(screen.getByRole('button', { name: /Sender/ }));
      expect(mocks.messaging.selectConversation).toHaveBeenCalledWith('conversation-1', { dock: true });
      expect(onRoute).toHaveBeenCalledWith('conversation-1');
    });
  });

  describe('new message', () => {
    it('searches people, hides yourself and non-real accounts, and starts a compose', async () => {
      mocks.api.get.mockResolvedValue({
        users: [
          { id: 'u1', username: 'friend', display_name: 'Friend', account_type: 'real' },
          { id: 'u2', username: 'viewer', display_name: 'Me', account_type: 'real', is_me: true },
          { id: 'u3', username: 'demo_bot', display_name: 'Demo', account_type: 'demo' },
        ],
      });
      mocks.messaging.selectedId = null;
      mocks.messaging.requests = [];
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /NEW MESSAGE/ }));
      fireEvent.change(screen.getByLabelText('Search people to message'), { target: { value: 'fr' } });
      const person = await screen.findByRole('button', { name: /@friend/ });
      expect(screen.queryByText('@demo_bot')).not.toBeInTheDocument();
      expect(mocks.api.get).toHaveBeenCalledWith('/api/search/suggestions', { q: 'fr', limit: 8 });
      fireEvent.click(person);
      expect(mocks.messaging.composeTo).toHaveBeenCalledWith('friend', { dock: false });
    });

    it('says when nothing matches and when search fails', async () => {
      mocks.api.get.mockResolvedValueOnce({ users: [] }).mockRejectedValueOnce(new Error('down'));
      mocks.messaging.selectedId = null;
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /NEW MESSAGE/ }));
      const search = screen.getByLabelText('Search people to message');
      fireEvent.change(search, { target: { value: 'nobody' } });
      expect(await screen.findByText('NO MATCHING PEOPLE')).toBeInTheDocument();
      fireEvent.change(search, { target: { value: 'again' } });
      expect(await screen.findByText('SEARCH FAILED — TRY AGAIN')).toBeInTheDocument();
    });

    it('closes the search with Escape', () => {
      mocks.messaging.selectedId = null;
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /NEW MESSAGE/ }));
      fireEvent.keyDown(screen.getByLabelText('Search people to message'), { key: 'Escape' });
      expect(screen.queryByLabelText('Search people to message')).not.toBeInTheDocument();
    });

    it('opens the existing conversation instead of an empty compose for someone you already talk to', () => {
      mocks.messaging.requests = [];
      mocks.messaging.selectedId = null;
      mocks.messaging.composeUsername = 'Sender';
      mocks.messaging.inbox = [activeConversation()];
      const onRoute = vi.fn();
      renderPanel({ onConversationRoute: onRoute });
      expect(mocks.messaging.selectConversation).toHaveBeenCalledWith('conversation-1', { dock: false });
      expect(onRoute).toHaveBeenCalledWith('conversation-1');
    });
  });

  describe('thread and composer', () => {
    beforeEach(() => {
      mocks.messaging.requests = [];
      mocks.messaging.inbox = [activeConversation()];
      mocks.messaging.messages = {
        'conversation-1': [
          message({ id: 'm1', created_at: '2026-09-10T10:00:00Z', text: 'older', content: { text: 'older' } }),
          message({ id: 'm2', sender_id: 'viewer-id', created_at: '2026-09-11T10:00:00Z', text: 'newer', content: { text: 'newer' }, can_delete: true, can_report: false, read_by_recipient: true }),
        ],
      };
    });

    it('renders day separators, read state and per-message actions', () => {
      renderPanel();
      expect(screen.getAllByRole('separator')).toHaveLength(2);
      const mine = screen.getByText('newer').closest('article');
      expect(mine).toHaveClass('sx-mine');
      expect(within(mine).getByText('READ')).toBeInTheDocument();
      expect(within(mine).getByRole('button', { name: 'DELETE' })).toBeInTheDocument();
      expect(within(screen.getByText('older').closest('article')).getByRole('button', { name: 'REPORT' })).toBeInTheDocument();
    });

    it('sends with Enter, keeps Shift+Enter for a newline and ignores IME composition', async () => {
      mocks.messaging.draft = '  hello  ';
      renderPanel();
      const box = screen.getByLabelText('Message');
      fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
      fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
      expect(mocks.messaging.send).not.toHaveBeenCalled();
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => expect(mocks.messaging.send).toHaveBeenCalledWith({ kind: 'text', text: 'hello' }));
    });

    it('does not send empty drafts or double-send while busy', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: /SEND/ })).toBeDisabled();
      cleanup();
      mocks.messaging.draft = 'hi';
      mocks.messaging.busy = true;
      renderPanel();
      expect(screen.getByRole('button', { name: /SENDING/ })).toBeDisabled();
      fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
      expect(mocks.messaging.send).not.toHaveBeenCalled();
    });

    it('keeps the draft and shows a dismissable error when sending fails', async () => {
      mocks.messaging.draft = 'will fail';
      mocks.messaging.error = 'Could not send message.';
      mocks.messaging.send.mockRejectedValue(new Error('x'));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /SEND/ }));
      await waitFor(() => expect(mocks.messaging.send).toHaveBeenCalled());
      expect(screen.getByLabelText('Message')).toHaveValue('will fail');
      expect(screen.getByRole('alert')).toHaveTextContent('Could not send message.');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
      expect(mocks.messaging.setError).toHaveBeenCalledWith('');
    });

    it('shows a character counter near the 2,000 limit', () => {
      mocks.messaging.draft = 'x'.repeat(1650);
      renderPanel();
      expect(screen.getByText('1,650 / 2,000')).toBeInTheDocument();
      expect(screen.getByLabelText('Message')).toHaveAttribute('maxlength', '2000');
    });

    it('sends an emote and closes the picker', async () => {
      renderPanel();
      const picker = screen.getByLabelText('Choose an emote').closest('details');
      picker.open = true;
      fireEvent.click(screen.getByRole('button', { name: '🔥' }));
      await waitFor(() => expect(mocks.messaging.send).toHaveBeenCalledWith({ kind: 'emote', emote: '🔥' }));
      expect(picker.open).toBe(false);
    });

    it('disables GIF when Tenor is not configured and searches/sends when it is', async () => {
      renderPanel();
      expect(screen.getByRole('button', { name: 'GIF' })).toBeDisabled();
      cleanup();
      mocks.messaging.capabilities = { curated_emotes: [], gifs: { available: true } };
      mocks.api.get.mockResolvedValue({ results: [{ id: 'g1', url: 'https://media.tenor.com/a.gif', preview_url: 'https://media.tenor.com/a-p.gif', title: 'wave' }] });
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'GIF' }));
      fireEvent.change(screen.getByLabelText('Search GIFs'), { target: { value: 'wave' } });
      fireEvent.click(screen.getByRole('button', { name: 'SEARCH' }));
      fireEvent.click(await screen.findByAltText('wave'));
      await waitFor(() => expect(mocks.messaging.send).toHaveBeenCalledWith({
        kind: 'gif',
        gif_url: 'https://media.tenor.com/a.gif',
        gif_preview_url: 'https://media.tenor.com/a-p.gif',
        gif_title: 'wave',
      }));
      expect(mocks.api.get).toHaveBeenCalledWith('/api/messages/gifs/search', { q: 'wave', limit: 18 });
    });

    it('loads earlier history using the stored cursor', async () => {
      mocks.messaging.historyCursors = { 'conversation-1': 'cursor-1' };
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'LOAD EARLIER' }));
      await waitFor(() => expect(mocks.messaging.loadConversation).toHaveBeenCalledWith('conversation-1', { before: 'cursor-1' }));
      expect(mocks.messaging.loadConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe('safety actions', () => {
    beforeEach(() => {
      mocks.messaging.requests = [];
      mocks.messaging.inbox = [activeConversation()];
      mocks.messaging.messages = {
        'conversation-1': [
          message({ id: 'theirs', text: 'rude', content: { text: 'rude' } }),
          message({ id: 'mine', sender_id: 'viewer-id', text: 'oops', content: { text: 'oops' }, can_delete: true, can_report: false }),
        ],
      };
    });

    it('asks before deleting and only then deletes', async () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
      expect(mocks.messaging.deleteMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
      expect(screen.queryByRole('button', { name: 'CONFIRM DELETE' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
      fireEvent.click(screen.getByRole('button', { name: 'CONFIRM DELETE' }));
      await waitFor(() => expect(mocks.messaging.deleteMessage).toHaveBeenCalledWith('mine', 'conversation-1'));
    });

    it('reports a delete failure instead of throwing', async () => {
      mocks.messaging.deleteMessage.mockRejectedValue(new Error('Only the sender can delete this message.'));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
      fireEvent.click(screen.getByRole('button', { name: 'CONFIRM DELETE' }));
      expect(await screen.findByText('Only the sender can delete this message.')).toBeInTheDocument();
    });

    it('reports a message through an in-app form with the chosen reason', async () => {
      mocks.api.post.mockResolvedValue({ ok: true });
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      const form = screen.getByRole('form', { name: 'Report message' });
      fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'harassment' } });
      fireEvent.change(within(form).getByRole('textbox'), { target: { value: '  threatening me  ' } });
      fireEvent.click(within(form).getByRole('button', { name: 'SUBMIT REPORT' }));
      await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/reports', {
        target_type: 'message',
        target_id: 'theirs',
        reason: 'harassment',
        details: 'threatening me',
      }));
      expect(await screen.findByText(/Report submitted/)).toBeInTheDocument();
      expect(screen.queryByRole('form', { name: 'Report message' })).not.toBeInTheDocument();
    });

    it('keeps the report form open and explains a failure', async () => {
      mocks.api.post.mockRejectedValue(new Error('Too many reports.'));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      fireEvent.click(screen.getByRole('button', { name: 'SUBMIT REPORT' }));
      expect(await screen.findByText('Too many reports.')).toBeInTheDocument();
      expect(screen.getByRole('form', { name: 'Report message' })).toBeInTheDocument();
    });

    it('can cancel a report', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel report' }));
      expect(screen.queryByRole('form', { name: 'Report message' })).not.toBeInTheDocument();
    });

    it('confirms before blocking, blocks the right handle and leaves the thread', async () => {
      mocks.api.put.mockResolvedValue({});
      const onRoute = vi.fn();
      renderPanel({ onConversationRoute: onRoute });
      fireEvent.click(screen.getByRole('button', { name: 'BLOCK' }));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent('Block @sender?');
      expect(mocks.api.put).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'BLOCK' }));
      await waitFor(() => expect(mocks.api.put).toHaveBeenCalledWith('/api/users/sender/block'));
      await waitFor(() => expect(mocks.messaging.refreshAll).toHaveBeenCalled());
      expect(mocks.messaging.selectConversation).toHaveBeenCalledWith(null);
      expect(onRoute).toHaveBeenCalledWith(null);
    });

    it('cancelling the block confirmation does nothing', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'BLOCK' }));
      fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mocks.api.put).not.toHaveBeenCalled();
    });

    it('shows a block failure and stays in the thread', async () => {
      mocks.api.put.mockRejectedValue(new Error('Could not block this user.'));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'BLOCK' }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'BLOCK' }));
      expect(await screen.findByText('Could not block this user.')).toBeInTheDocument();
      expect(mocks.messaging.selectConversation).not.toHaveBeenCalled();
    });
  });

  describe('message requests', () => {
    it('declines, then closes the thread', async () => {
      const onRoute = vi.fn();
      renderPanel({ onConversationRoute: onRoute });
      fireEvent.click(screen.getByRole('button', { name: 'DECLINE' }));
      await waitFor(() => expect(mocks.messaging.decideRequest).toHaveBeenCalledWith('conversation-1', 'decline'));
      await waitFor(() => expect(onRoute).toHaveBeenCalledWith(null));
    });

    it('shows an accept failure instead of an unhandled rejection', async () => {
      mocks.messaging.decideRequest.mockRejectedValue(new Error('This conversation is not an incoming request.'));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'ACCEPT' }));
      expect(await screen.findByText('This conversation is not an incoming request.')).toBeInTheDocument();
    });

    it('explains the outgoing pending state and hides the composer', () => {
      mocks.messaging.requests = [];
      mocks.messaging.inbox = [conversation({ is_request: false, requester_id: 'viewer-id', can_message: false })];
      renderPanel();
      expect(screen.getByText('Waiting for @sender to accept your request.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    });

    it.each([
      [{ state: 'declined', is_request: false, can_message: false }, 'This message request was declined.'],
      [{ state: 'active', is_request: false, blocked: true, can_message: false }, 'Messaging is unavailable — one of you has blocked the other.'],
      [{ state: 'active', is_request: false, can_message: false }, 'You can no longer reply in this conversation.'],
      [{ state: 'active', is_request: false, participant: { id: 's', username: 'sender', display_name: 'Unavailable account', account_type: 'real', status: 'suspended' } }, 'This account is no longer available.'],
    ])('replaces the composer with a reason when messaging is closed (%#)', (overrides, text) => {
      mocks.messaging.requests = [];
      mocks.messaging.inbox = [activeConversation(overrides)];
      renderPanel();
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    });
  });

  describe('load more', () => {
    const sized = (node, { scrollHeight, clientHeight, scrollTop }) => {
      Object.defineProperty(node, 'scrollHeight', { configurable: true, value: scrollHeight });
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: clientHeight });
      node.scrollTop = scrollTop;
    };

    beforeEach(() => {
      mocks.messaging.requests = [];
      mocks.messaging.inbox = [activeConversation()];
      mocks.messaging.loadMoreBox = vi.fn().mockResolvedValue(null);
      mocks.messaging.boxCursors = { inbox: 'next-page', requests: null };
      mocks.messaging.boxLoadingMore = { inbox: false, requests: false };
      mocks.messaging.messages = { 'conversation-1': [message()] };
      mocks.messaging.historyCursors = { 'conversation-1': 'older-cursor' };
    });

    it('offers LOAD MORE for conversations on the full page and loads the next page', async () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      await waitFor(() => expect(mocks.messaging.loadMoreBox).toHaveBeenCalledWith('inbox'));
      expect(screen.getByText(/1\+ CONVERSATIONS/)).toBeInTheDocument();
    });

    it('has no LOAD MORE button when everything is loaded or while loading', () => {
      mocks.messaging.boxCursors = { inbox: null, requests: null };
      renderPanel();
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
      cleanup();
      mocks.messaging.boxCursors = { inbox: 'next-page', requests: null };
      mocks.messaging.boxLoadingMore = { inbox: true, requests: false };
      renderPanel();
      expect(screen.getByRole('button', { name: 'LOADING…' })).toBeDisabled();
    });

    it('loads more conversations when the list is scrolled near its end, in the page and the dock', () => {
      for (const compact of [false, true]) {
        mocks.messaging.loadMoreBox.mockClear();
        const { container, unmount } = renderPanel({ compact });
        const list = container.querySelector('.sx-conversation-list');
        sized(list, { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
        fireEvent.scroll(list);
        expect(mocks.messaging.loadMoreBox).not.toHaveBeenCalled();
        sized(list, { scrollHeight: 2000, clientHeight: 400, scrollTop: 1550 });
        fireEvent.scroll(list);
        expect(mocks.messaging.loadMoreBox).toHaveBeenCalledWith('inbox');
        unmount();
      }
    });

    it('hides the list button in the dock (scrolling loads instead)', () => {
      renderPanel({ compact: true });
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('does not request more conversations when there is no next page', () => {
      mocks.messaging.boxCursors = { inbox: null, requests: null };
      const { container } = renderPanel();
      const list = container.querySelector('.sx-conversation-list');
      sized(list, { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 });
      fireEvent.scroll(list);
      expect(mocks.messaging.loadMoreBox).not.toHaveBeenCalled();
    });

    it('shows a conversation paging error', async () => {
      mocks.messaging.loadMoreBox.mockRejectedValue(new Error('Could not load more conversations.'));
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(await screen.findByText('Could not load more conversations.')).toBeInTheDocument();
    });

    it('loads earlier messages when the thread is scrolled to the top, page and dock alike', async () => {
      for (const compact of [false, true]) {
        mocks.messaging.loadConversation.mockClear();
        const { container, unmount } = renderPanel({ compact });
        const history = container.querySelector('.sx-message-history');
        sized(history, { scrollHeight: 3000, clientHeight: 500, scrollTop: 1200 });
        fireEvent.scroll(history);
        expect(mocks.messaging.loadConversation).not.toHaveBeenCalled();
        sized(history, { scrollHeight: 3000, clientHeight: 500, scrollTop: 20 });
        fireEvent.scroll(history);
        await waitFor(() => expect(mocks.messaging.loadConversation).toHaveBeenCalledWith('conversation-1', { before: 'older-cursor' }));
        unmount();
      }
    });

    it('does not fire a second earlier-load while one is in flight', async () => {
      let finish;
      mocks.messaging.loadConversation.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const { container } = renderPanel();
      const history = container.querySelector('.sx-message-history');
      sized(history, { scrollHeight: 3000, clientHeight: 500, scrollTop: 10 });
      fireEvent.scroll(history);
      fireEvent.scroll(history);
      fireEvent.scroll(history);
      expect(mocks.messaging.loadConversation).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'LOADING…' })).toBeDisabled();
      finish(null);
      await waitFor(() => expect(screen.getByRole('button', { name: 'LOAD EARLIER' })).toBeEnabled());
    });

    it('keeps the reader on the same message after older ones prepend, from any scroll offset', async () => {
      const view = renderPanel();
      const history = view.container.querySelector('.sx-message-history');
      let height = 3000;
      Object.defineProperty(history, 'scrollHeight', { configurable: true, get: () => height });
      Object.defineProperty(history, 'clientHeight', { configurable: true, value: 500 });
      history.scrollTop = 250;
      mocks.messaging.loadConversation.mockImplementation(async () => {
        height = 5000; // 2,000px of older messages were prepended
        mocks.messaging.messages = {
          'conversation-1': [message({ id: 'older-1', text: 'older 1', content: { text: 'older 1' } }), message({ id: 'older-2', text: 'older 2', content: { text: 'older 2' } }), message()],
        };
        view.rerender(<MemoryRouter><MessagingPanel /></MemoryRouter>);
        return null;
      });
      fireEvent.click(screen.getByRole('button', { name: 'LOAD EARLIER' }));
      await waitFor(() => expect(screen.getByText('older 2')).toBeInTheDocument());
      expect(history.scrollTop).toBe(2250);
    });

    it('keeps the LOAD EARLIER button on the full page only', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: 'LOAD EARLIER' })).toBeInTheDocument();
      cleanup();
      renderPanel({ compact: true });
      expect(screen.queryByRole('button', { name: 'LOAD EARLIER' })).not.toBeInTheDocument();
    });

    it('does not auto-load when there is nothing older', () => {
      mocks.messaging.historyCursors = {};
      const { container } = renderPanel();
      const history = container.querySelector('.sx-message-history');
      sized(history, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
      fireEvent.scroll(history);
      expect(mocks.messaging.loadConversation).not.toHaveBeenCalled();
    });

    it('keeps paging when the loaded messages do not fill the thread', async () => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 300 });
      try {
        renderPanel();
        await waitFor(() => expect(mocks.messaging.loadConversation).toHaveBeenCalledWith('conversation-1', { before: 'older-cursor' }));
      } finally {
        if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
        else delete HTMLElement.prototype.clientHeight;
        delete HTMLElement.prototype.scrollHeight;
      }
    });
  });

  describe('responsive panes', () => {
    it('opens the list pane when nothing is selected', () => {
      mocks.messaging.selectedId = null;
      const { container } = renderPanel();
      expect(container.querySelector('.sx-messaging-panel')).toHaveAttribute('data-pane', 'list');
    });

    it('shows the thread pane and a back button that clears the selection', () => {
      const onRoute = vi.fn();
      const { container } = renderPanel({ onConversationRoute: onRoute });
      expect(container.querySelector('.sx-messaging-panel')).toHaveAttribute('data-pane', 'thread');
      fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
      expect(mocks.messaging.selectConversation).toHaveBeenCalledWith(null);
      expect(onRoute).toHaveBeenCalledWith(null);
    });
  });
});

describe('MessageDock', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.user = { id: 'viewer-id', username: 'viewer' };
    mocks.messaging = baseMessaging();
    Object.values(mocks.api).forEach((fn) => fn.mockReset());
  });

  it('shows the compact launcher with the unread count and opens the dock', async () => {
    const user = userEvent.setup();
    mocks.messaging.dockOpen = false;
    render(<MemoryRouter><MessageDock /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: /Open compact messages, 1 unread/ }));
    expect(mocks.messaging.setDockOpen).toHaveBeenCalledWith(true);
    expect(mocks.messaging.loadConversation).toHaveBeenCalledWith('conversation-1');
  });

  it('renders nothing for signed-out visitors', () => {
    mocks.user = null;
    const { container } = render(<MemoryRouter><MessageDock /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it('caps a huge unread count on the launcher', () => {
    mocks.messaging.dockOpen = false;
    mocks.messaging.unread = { inbox: 150, requests: 0, total: 150 };
    render(<MemoryRouter><MessageDock /></MemoryRouter>);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('shows status, minimizes, expands and closes', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MessageDock /></MemoryRouter>);
    expect(screen.getByText('1 UNREAD')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Compact messages' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Minimize messages' }));
    expect(mocks.messaging.setDockMinimized).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Close messages' }));
    expect(mocks.messaging.setDockOpen).toHaveBeenCalledWith(false);
  });

  it('reloads the open conversation when expanding from minimized', async () => {
    const user = userEvent.setup();
    mocks.messaging.dockMinimized = true;
    render(<MemoryRouter><MessageDock /></MemoryRouter>);
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand messages' }));
    expect(mocks.messaging.setDockMinimized).toHaveBeenCalledWith(false);
    expect(mocks.messaging.loadConversation).toHaveBeenCalledWith('conversation-1');
  });

  it('uses the same panel as the full page, in compact mode', () => {
    const { container } = render(<MemoryRouter><MessageDock /></MemoryRouter>);
    expect(container.querySelector('.sx-message-dock .sx-messaging-panel--compact')).not.toBeNull();
  });
});
