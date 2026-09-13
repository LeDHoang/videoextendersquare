import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useMessaging } from '../../hooks/MessagingContext.jsx';
import { useWallet } from '../../hooks/WalletContext.jsx';
import {
  IndustrialUploadIcon,
  IndustrialMessageIcon,
  IndustrialCreditsIcon,
} from '../icons/index.jsx';

function compactCount(value) {
  const count = Number(value) || 0;
  if (count >= 1000000) return parseFloat((count / 1000000).toFixed(1)) + 'M';
  if (count >= 1000) return parseFloat((count / 1000).toFixed(1)) + 'K';
  return String(count);
}

function commandFallback(query) {
  const value = query.toLowerCase();
  if (value.includes('comp') || value === 'ab' || value.includes('diff')) return '/compare';
  if (value.includes('upload') || value.includes('post') || value.includes('share') || value.includes('publish')) return '/upload';
  if (value === 'explore' || value === 'gallery' || value === 'browse') return '/explore';
  if (value === 'reels' || value === 'vr' || value === 'quest' || value === '3d') return '/reels';
  if (value === 'video' || value === 'extend video') return '/video';
  if (value === 'image' || value === 'photo' || value === 'picture') return '/image';
  return '/explore?search=' + encodeURIComponent(query);
}

function AccountAvatar({ user }) {
  const label = (user?.display_name || user?.username || '?').trim();
  return (
    <span className="sx-account-avatar" style={{ backgroundColor: user?.avatar_color || 'var(--sx-accent)' }}>
      {user?.avatar_url ? <img src={user.avatar_url} alt="" /> : label.slice(0, 2).toUpperCase()}
    </span>
  );
}

export default function HeaderBar({ onToggleSidebar, hidden = false }) {
  const { user, loading: authLoading, logout } = useAuth();
  const messaging = useMessaging();
  const { wallet } = useWallet();
  const location = useLocation();
  const navigate = useNavigate();
  const searchInputRef = useRef(null);
  const searchBoxRef = useRef(null);
  const accountRef = useRef(null);
  const requestSequence = useRef(0);
  const [searchVal, setSearchVal] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState([]);
  const [userSuggestions, setUserSuggestions] = useState([]);
  const [postSuggestions, setPostSuggestions] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  const selectable = [
    ...userSuggestions.map((item) => ({ type: 'user', item })),
    ...tagSuggestions.map((item) => ({ type: 'tag', item })),
    ...postSuggestions.map((item) => ({ type: 'post', item })),
  ];

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMobileSearchOpen(true);
        searchInputRef.current?.focus();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (mobileSearchOpen) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [mobileSearchOpen]);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target)) {
        setSearchOpen(false);
        setActiveIndex(-1);
        if (mobileSearchOpen) {
          setMobileSearchOpen(false);
        }
      }
      if (accountRef.current && !accountRef.current.contains(event.target)) {
        setAccountOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [mobileSearchOpen]);

  useEffect(() => {
    setSearchOpen(false);
    setAccountOpen(false);
    setMobileSearchOpen(false);
    setActiveIndex(-1);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!searchOpen) return undefined;
    const query = searchVal.trim();
    const sequence = ++requestSequence.current;
    const timer = setTimeout(() => {
      setSearchBusy(true);
      api.get('/api/search/suggestions', { q: query, limit: 6 })
        .then((response) => {
          if (sequence !== requestSequence.current) return;
          setTagSuggestions(response.tags || []);
          setUserSuggestions(response.users || []);
          setPostSuggestions(response.posts || []);
        })
        .catch(() => {
          if (sequence === requestSequence.current) {
            setTagSuggestions([]);
            setUserSuggestions([]);
            setPostSuggestions([]);
          }
        })
        .finally(() => {
          if (sequence === requestSequence.current) setSearchBusy(false);
        });
    }, query ? 140 : 0);
    return () => clearTimeout(timer);
  }, [searchVal, searchOpen]);

  const closeSearchAndNavigate = (destination) => {
    setSearchOpen(false);
    setMobileSearchOpen(false);
    setActiveIndex(-1);
    searchInputRef.current?.blur();
    navigate(destination);
    setSearchVal('');
  };

  const openResult = (result) => {
    if (!result) return;
    if (result.type === 'user') {
      closeSearchAndNavigate('/profile/' + encodeURIComponent(result.item.username));
    } else if (result.type === 'tag') {
      closeSearchAndNavigate('/explore/tag/' + encodeURIComponent(result.item.slug));
    } else {
      const params = new URLSearchParams({
        folder: 'ALL FOLDERS',
        codec: 'all',
        sort: 'newest',
        play: result.item.path,
      });
      closeSearchAndNavigate('/reels?' + params.toString());
    }
  };

  const runContentSearch = () => {
    const query = searchVal.trim();
    if (query) closeSearchAndNavigate('/explore?search=' + encodeURIComponent(query));
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setSearchOpen(false);
      setMobileSearchOpen(false);
      setActiveIndex(-1);
      searchInputRef.current?.blur();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSearchOpen(true);
      setActiveIndex((current) => selectable.length ? (current + 1) % selectable.length : -1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSearchOpen(true);
      setActiveIndex((current) => selectable.length ? (current <= 0 ? selectable.length - 1 : current - 1) : -1);
      return;
    }
    if (event.key === 'Enter' && searchVal.trim()) {
      event.preventDefault();
      const selected = selectable[activeIndex] || selectable[0];
      if (selected) openResult(selected);
      else closeSearchAndNavigate(commandFallback(searchVal.trim()));
    }
  };

  const resultCount = selectable.length;
  const showSearchMenu = Boolean(searchOpen && (searchBusy || resultCount || searchVal.trim()));

  const renderSearchResults = () => (
    <div className="sx-command-results">
      <div className="sx-command-results-head">
        <span>{searchVal.trim() ? 'PEOPLE + TAGS + POSTS' : 'POPULAR DISCOVERY'}</span>
        <span>{searchBusy ? 'SCANNING…' : resultCount + ' FOUND'}</span>
      </div>
      <div id="sx-global-search-results" role="listbox">
        {userSuggestions.length ? <div className="sx-command-group-label">PEOPLE</div> : null}
        {userSuggestions.map((person, index) => (
          <button
            type="button"
            id={'sx-search-result-' + index}
            key={'user-' + person.id}
            role="option"
            aria-selected={index === activeIndex}
            className={'sx-command-result ' + (index === activeIndex ? 'sx-active' : '')}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => openResult({ type: 'user', item: person })}
          >
            <AccountAvatar user={person} />
            <span className="sx-command-result-copy">
              <strong>@{person.username}</strong>
              <small>{person.display_name + ' · ' + compactCount(person.follower_count) + ' FOLLOWERS'}</small>
            </span>
            <span className="sx-command-result-arrow" aria-hidden="true">↗</span>
          </button>
        ))}
        {tagSuggestions.length ? <div className="sx-command-group-label">TAGS</div> : null}
        {tagSuggestions.map((tag, tagIndex) => {
          const index = userSuggestions.length + tagIndex;
          return (
            <button
              type="button"
              id={'sx-search-result-' + index}
              key={'tag-' + tag.slug}
              role="option"
              aria-selected={index === activeIndex}
              className={'sx-command-result ' + (index === activeIndex ? 'sx-active' : '')}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => openResult({ type: 'tag', item: tag })}
            >
              <span className="sx-command-result-mark">#</span>
              <span className="sx-command-result-copy">
                <strong>{tag.name}</strong>
                <small>{tag.reel_count + ' POSTS · ' + compactCount(tag.views) + ' VIEWS · ' + tag.reason}</small>
              </span>
              <span className="sx-command-result-arrow" aria-hidden="true">↗</span>
            </button>
          );
        })}
        {postSuggestions.length ? <div className="sx-command-group-label">POSTS</div> : null}
        {postSuggestions.map((post, postIndex) => {
          const index = userSuggestions.length + tagSuggestions.length + postIndex;
          return (
            <button
              type="button"
              id={'sx-search-result-' + index}
              key={'post-' + post.id}
              role="option"
              aria-selected={index === activeIndex}
              className={'sx-command-result ' + (index === activeIndex ? 'sx-active' : '')}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => openResult({ type: 'post', item: post })}
            >
              <span className="sx-command-result-mark">▶</span>
              <span className="sx-command-result-copy">
                <strong>{post.title || post.path.split('/').pop()}</strong>
                <small>{'@' + post.creator.username + ' · ' + compactCount(post.views) + ' VIEWS'}</small>
              </span>
              <span className="sx-command-result-arrow" aria-hidden="true">↗</span>
            </button>
          );
        })}
      </div>
      {!searchBusy && searchVal.trim() && !resultCount ? <div className="sx-command-empty">NO PEOPLE, TAGS, OR POSTS FOUND</div> : null}
      {searchVal.trim() ? (
        <button type="button" className="sx-command-search-all" onMouseDown={(event) => event.preventDefault()} onClick={runContentSearch}>
          <span>⌕ SEARCH ALL POSTS</span>
          <small>{'“' + searchVal.trim() + '”'}</small>
        </button>
      ) : null}
    </div>
  );

  return (
    <header
      className={'sx-top-bar ' + (hidden ? 'sx-top-bar--hidden ' : '') + (mobileSearchOpen ? 'sx-top-bar--mobile-search-active' : '')}
      aria-hidden={hidden ? 'true' : undefined}
      style={hidden ? { pointerEvents: 'none' } : undefined}
    >
      {mobileSearchOpen ? (
        <div className="sx-mobile-search-row" ref={searchBoxRef}>
          <button
            type="button"
            className="sx-mobile-search-back-btn"
            onClick={() => {
              setMobileSearchOpen(false);
              setSearchOpen(false);
              setActiveIndex(-1);
            }}
            aria-label="Close search"
            title="Close Search"
          >
            ←
          </button>
          <div className="sx-command-box sx-command-box--mobile-active sx-command-box--open">
            <span className="sx-command-icon" aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              type="text"
              className="sx-command-input"
              placeholder="SEARCH PEOPLE, TAGS, REELS…"
              value={searchVal}
              onChange={(event) => {
                setSearchVal(event.target.value);
                setSearchOpen(true);
                setActiveIndex(-1);
              }}
              onKeyDown={handleSearchKeyDown}
              role="combobox"
              aria-label="Search people, tags, and reels"
              aria-autocomplete="list"
              aria-expanded={showSearchMenu}
              aria-controls="sx-global-search-results"
              aria-activedescendant={activeIndex >= 0 ? 'sx-search-result-' + activeIndex : undefined}
            />
            {searchVal ? (
              <button
                type="button"
                className="sx-mobile-search-clear-btn"
                onClick={() => {
                  setSearchVal('');
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear query"
              >
                ✕
              </button>
            ) : null}
            {searchBusy ? <span className="sx-command-busy-indicator">…</span> : null}
          </div>
          {showSearchMenu ? renderSearchResults() : null}
        </div>
      ) : (
        <>
          <div className="sx-top-left">
            <button type="button" className="sx-icon-btn" onClick={onToggleSidebar} title="Open/Close Sidebar" aria-label="Toggle Sidebar">
              <span style={{ fontSize: '1.14rem', lineHeight: 1 }}>☰</span>
            </button>
            <NavLink to="/reels" className="sx-top-brand" title="ECHO 4K Engine">
              <img src="/logo.svg" alt="ECHO Logo" className="sx-top-logo" />
              <span>ECHO</span>
            </NavLink>
            <nav className="sx-top-nav" aria-label="Global Routes">
              <NavLink to="/reels" className={({ isActive }) => 'sx-top-link ' + (isActive ? 'sx-active' : '')}>REELS/VR</NavLink>
              <NavLink to="/explore" className={({ isActive }) => 'sx-top-link ' + (isActive ? 'sx-active' : '')}>EXPLORE</NavLink>
              <NavLink to="/upload" className={({ isActive }) => 'sx-top-link ' + (isActive ? 'sx-active' : '')}>UPLOAD</NavLink>
              <NavLink to="/compare" className={({ isActive }) => 'sx-top-link ' + (isActive ? 'sx-active' : '')}>COMPARE</NavLink>
            </nav>
          </div>

          <div className="sx-top-center">
            <div ref={searchBoxRef} className={'sx-command-box ' + (searchOpen ? 'sx-command-box--open' : '')}>
              <span className="sx-command-icon" aria-hidden="true">⌕</span>
              <input
                ref={searchInputRef}
                type="text"
                className="sx-command-input"
                placeholder="SEARCH PEOPLE, TAGS, REELS…"
                value={searchVal}
                onChange={(event) => {
                  setSearchVal(event.target.value);
                  setSearchOpen(true);
                  setActiveIndex(-1);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={handleSearchKeyDown}
                role="combobox"
                aria-label="Search people, tags, and reels"
                aria-autocomplete="list"
                aria-expanded={showSearchMenu}
                aria-controls="sx-global-search-results"
                aria-activedescendant={activeIndex >= 0 ? 'sx-search-result-' + activeIndex : undefined}
              />
              <div className="sx-command-kbd" aria-hidden="true">
                {searchBusy ? <span>…</span> : <><span>⌘</span><span>K</span></>}
              </div>

              {showSearchMenu ? renderSearchResults() : null}
            </div>
          </div>

          <div className="sx-top-right">
            {/* Mobile-only Search Trigger Button */}
            <button
              type="button"
              className="sx-top-icon-btn sx-top-search-trigger"
              onClick={() => {
                setMobileSearchOpen(true);
                setSearchOpen(true);
              }}
              title="Search"
              aria-label="Open Search"
            >
              <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>⌕</span>
            </button>

            {/* Credits: full text on desktop, compact pill on tablet/mobile */}
            {user ? (
              <>
                <button
                  type="button"
                  className="sx-top-action-btn sx-desktop-only"
                  onClick={() => navigate('/wallet')}
                  title="Open ECHO Credits wallet"
                >
                  {wallet?.available_credits ?? '—'} CREDITS
                </button>
                <button
                  type="button"
                  className="sx-top-credits-pill sx-mobile-tablet-only"
                  onClick={() => navigate('/wallet')}
                  title="Open ECHO Credits wallet"
                  aria-label="ECHO Credits"
                >
                  <IndustrialCreditsIcon className="sx-top-btn-svg" />
                  <span>{wallet?.available_credits ?? '—'}</span>
                </button>
              </>
            ) : null}

            {/* Upload: full text on desktop, icon button on tablet/mobile */}
            <button
              type="button"
              className="sx-top-action-btn sx-desktop-only"
              onClick={() => navigate('/upload')}
              title="Open the Upload page"
            >
              UPLOAD
            </button>
            <button
              type="button"
              className="sx-top-icon-btn sx-mobile-tablet-only"
              onClick={() => navigate('/upload')}
              title="Upload Video or Image"
              aria-label="Upload"
            >
              <IndustrialUploadIcon className="sx-top-btn-svg" />
            </button>

            {/* Messages: full text on desktop, icon with badge on tablet/mobile */}
            {user ? (
              <>
                <button
                  type="button"
                  className="sx-top-action-btn sx-message-nav-btn sx-desktop-only"
                  onClick={() => navigate('/messages')}
                  title="Open messages"
                >
                  MESSAGES {messaging.unread.total ? <span>{messaging.unread.total}</span> : null}
                </button>
                <button
                  type="button"
                  className="sx-top-icon-btn sx-top-icon-btn--badge sx-mobile-tablet-only"
                  onClick={() => navigate('/messages')}
                  title="Open messages"
                  aria-label="Messages"
                >
                  <IndustrialMessageIcon className="sx-top-btn-svg" />
                  {messaging.unread.total ? (
                    <span className="sx-top-badge">
                      {messaging.unread.total > 99 ? '99+' : messaging.unread.total}
                    </span>
                  ) : null}
                </button>
              </>
            ) : null}

            {/* Account Menu / Sign In */}
            <div className="sx-account-menu" ref={accountRef}>
              {authLoading ? (
                <span className="sx-account-loading">…</span>
              ) : user ? (
                <>
                  <button
                    type="button"
                    className="sx-account-trigger"
                    onClick={() => setAccountOpen((open) => !open)}
                    aria-expanded={accountOpen}
                    aria-label="Open account menu"
                  >
                    <AccountAvatar user={user} />
                  </button>
                  {accountOpen ? (
                    <div className="sx-account-popover">
                      <div className="sx-account-popover-head">
                        <strong>@{user.username}</strong>
                        <small>{user.display_name}</small>
                        <span className="sx-account-popover-credits">
                          ⚡ {wallet?.available_credits ?? 0} CREDITS
                        </span>
                      </div>
                      <button type="button" onClick={() => navigate('/profile/' + user.username)}>PROFILE</button>
                      <button type="button" onClick={() => navigate('/profile/' + user.username + '?tab=saved')}>SAVED</button>
                      <button type="button" onClick={() => navigate('/settings/profile')}>SETTINGS</button>
                      <button type="button" onClick={() => navigate('/wallet')}>CREDITS / FAL KEY</button>
                      <button type="button" onClick={async () => { await logout(); navigate('/reels'); }}>LOG OUT</button>
                    </div>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  className="sx-account-signin"
                  onClick={() => navigate('/login?next=' + encodeURIComponent(location.pathname + location.search))}
                >
                  SIGN IN
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </header>
  );
}
