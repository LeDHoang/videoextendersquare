import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useMessaging } from '../../hooks/MessagingContext.jsx';
import { useWallet } from '../../hooks/WalletContext.jsx';
import { AnimatedEchoLogo } from '../icons/AnimatedEchoLogo.jsx';
import IconButton from '../ui/IconButton.jsx';
import { HEADER_NAV, NAV, accountNav } from './nav.js';

function compactCount(value) {
  const count = Number(value) || 0;
  if (count >= 1000000) return parseFloat((count / 1000000).toFixed(1)) + 'M';
  if (count >= 1000) return parseFloat((count / 1000).toFixed(1)) + 'K';
  return String(count);
}

// Compare, Video and Image are admin-only in the beta; others fall through to an Explore search.
function commandFallback(query, isAdmin) {
  const value = query.toLowerCase();
  if (isAdmin && (value.includes('comp') || value === 'ab' || value.includes('diff'))) return '/compare';
  if (value.includes('upload') || value.includes('post') || value.includes('share') || value.includes('publish')) return '/upload';
  if (value === 'explore' || value === 'gallery' || value === 'browse') return '/explore';
  if (value === 'reels' || value === 'vr' || value === 'quest' || value === '3d') return '/reels';
  if (isAdmin && (value === 'video' || value === 'extend video')) return '/video';
  if (isAdmin && (value === 'image' || value === 'photo' || value === 'picture')) return '/image';
  return '/explore?search=' + encodeURIComponent(query);
}

// Centre the initials by their ink, not their advance box: in a monospace face a wide
// letter beside a narrow one (W beside E) sits up to half a pixel off the disc's centre.
function useInkCentring(ref, text) {
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !text || !document.fonts) return undefined;
    let live = true;
    document.fonts.ready.then(() => {
      const ctx = live && document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      const style = getComputedStyle(el);
      // Measured at 100× the size, so the ink bounds are precise to a hundredth of a pixel.
      ctx.font = `${style.fontWeight} ${parseFloat(style.fontSize) * 100}px ${style.fontFamily}`;
      const m = ctx.measureText(text);
      setShift((m.width - m.actualBoundingBoxRight + m.actualBoundingBoxLeft) / 200);
    });
    return () => { live = false; };
  }, [ref, text]);
  return shift;
}

function AccountAvatar({ user }) {
  const label = (user?.display_name || user?.username || '?').trim();
  const initials = user?.avatar_url ? '' : label.slice(0, 2).toUpperCase();
  const ref = useRef(null);
  const shift = useInkCentring(ref, initials);
  return (
    <span ref={ref} className="sx-account-avatar" style={{ backgroundColor: user?.avatar_color || 'var(--sx-accent)' }}>
      {user?.avatar_url ? (
        <img src={user.avatar_url} alt="" />
      ) : (
        <span style={shift ? { position: 'relative', left: shift.toFixed(2) + 'px' } : undefined}>{initials}</span>
      )}
    </span>
  );
}

export default function HeaderBar({ onToggleSidebar, sidebarOpen = false, hidden = false }) {
  const { user, loading: authLoading, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
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
      else closeSearchAndNavigate(commandFallback(searchVal.trim(), isAdmin));
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
          <IconButton
            className="sx-mobile-search-back-btn"
            onClick={() => {
              setMobileSearchOpen(false);
              setSearchOpen(false);
              setActiveIndex(-1);
            }}
            label="Close search"
            title="Close Search"
          >
            ←
          </IconButton>
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
            <IconButton onClick={onToggleSidebar} title="Open/Close Sidebar" label="Toggle Sidebar" aria-expanded={sidebarOpen}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </IconButton>
            <NavLink to="/reels" className="sx-top-brand" title="ECHO 4K Engine">
              <AnimatedEchoLogo className="sx-top-logo" title="ECHO Logo" />
              <span className="sx-wordmark" data-echo="ECHO">ECHO</span>
            </NavLink>
            <nav className="sx-top-nav" aria-label="Global Routes">
              {HEADER_NAV.map(({ to, label }) => (
                <NavLink key={to} to={to} className={({ isActive }) => 'sx-top-link ' + (isActive ? 'sx-active' : '')}>{label}</NavLink>
              ))}
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
            <IconButton
              className="sx-top-search-trigger"
              onClick={() => {
                setMobileSearchOpen(true);
                setSearchOpen(true);
              }}
              title="Search"
              label="Open Search"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6" />
                <path d="M15 15l5 5" />
              </svg>
            </IconButton>

            {/* Right-side actions, in this order: UPLOAD (the one filled action), credits,
                messages, then the account avatar. They are links, so they can open in a new
                tab and report aria-current. Signed out, upload needs an account, so the one
                filled action is SIGN IN instead (CREATE ACCOUNT is a tab on that page). */}
            {user ? (
              <>
                <NavLink
                  to={NAV.upload.to}
                  className="sx-top-action-btn sx-desktop-only"
                  title="Open the Upload page"
                >
                  {NAV.upload.label}
                </NavLink>
                <IconButton
                  as={NavLink}
                  to={NAV.upload.to}
                  variant="primary"
                  className="sx-mobile-tablet-only"
                  title="Upload Video or Image"
                  label={NAV.upload.label}
                >
                  <NAV.upload.Icon className="sx-top-btn-svg" />
                </IconButton>
              </>
            ) : (
              <button
                type="button"
                className="sx-top-action-btn"
                onClick={() => navigate('/login?next=' + encodeURIComponent(location.pathname + location.search))}
              >
                SIGN IN
              </button>
            )}

            {user ? (
              <>
                <NavLink
                  to={NAV.credits.to}
                  className="sx-top-credits-pill"
                  title="Open ECHO Credits wallet"
                  aria-label={wallet?.available_credits != null ? `${wallet.available_credits} credits` : NAV.credits.label}
                >
                  <span>{wallet?.available_credits ?? '—'}</span>
                  <NAV.credits.Icon className="sx-top-btn-svg" />
                </NavLink>
                <IconButton
                  as={NavLink}
                  to={NAV.messages.to}
                  title="Open messages"
                  label={messaging.unread.total ? `${NAV.messages.label}, ${messaging.unread.total} unread` : NAV.messages.label}
                >
                  <NAV.messages.Icon className="sx-top-btn-svg" />
                  {messaging.unread.total ? (
                    <span className="sx-top-badge">
                      {messaging.unread.total > 99 ? '99+' : messaging.unread.total}
                    </span>
                  ) : null}
                </IconButton>
              </>
            ) : null}

            {/* Account Menu / Sign In */}
            <div className="sx-account-menu" ref={accountRef}>
              {authLoading ? (
                <span className="sx-account-loading">…</span>
              ) : user ? (
                <>
                  <IconButton
                    variant="plain"
                    className="sx-account-trigger"
                    onClick={() => setAccountOpen((open) => !open)}
                    aria-expanded={accountOpen}
                    label="Open account menu"
                  >
                    <AccountAvatar user={user} />
                  </IconButton>
                  {accountOpen ? (
                    <div className="sx-account-popover">
                      <div className="sx-account-popover-head">
                        <strong>@{user.username}</strong>
                        <small>{user.display_name}</small>
                        <span className="sx-account-popover-credits">
                          ⚡ {wallet?.available_credits ?? 0} CREDITS
                        </span>
                      </div>
                      {accountNav(user).map(({ to, label }) => <Link key={to} to={to}>{label}</Link>)}
                      <button type="button" onClick={async () => { await logout(); navigate('/reels'); }}>Log out</button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </>
      )}
    </header>
  );
}
