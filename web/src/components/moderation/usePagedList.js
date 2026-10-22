import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';

/**
 * One keyset-paged staff list ({ items, next_cursor }). Rows carry the query they were
 * loaded for, so a late response for an old filter never replaces the current rows.
 */
export function usePagedList(path, params) {
  const key = JSON.stringify(params);
  const [state, setState] = useState({ key: '', items: null, next: null, error: '' });
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setState({ key, items: null, next: null, error: '' });
    try {
      const page = await api.get(path, JSON.parse(key));
      setState((current) => (current.key === key ? { key, items: page.items, next: page.next_cursor, error: '' } : current));
    } catch (requestError) {
      setState((current) => (current.key === key
        ? { key, items: [], next: null, error: requestError.message || 'Could not load this list.' }
        : current));
    }
  }, [path, key]);

  useEffect(() => { load(); }, [load]);

  const more = async () => {
    if (!state.next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.get(path, { ...JSON.parse(key), cursor: state.next });
      setState((current) => (current.key === key
        ? { ...current, items: [...current.items, ...page.items], next: page.next_cursor }
        : current));
    } catch (requestError) {
      setState((current) => ({ ...current, error: requestError.message || 'Could not load more.' }));
    } finally {
      setLoadingMore(false);
    }
  };

  const replace = (item) => setState((current) => ({
    ...current,
    items: (current.items || []).map((row) => (row.id === item.id && row.type === item.type ? item : row)),
  }));

  return {
    items: state.key === key ? state.items : null,
    error: state.error,
    hasMore: Boolean(state.next),
    loadingMore,
    more,
    reload: load,
    replace,
  };
}

export function when(value) {
  return value ? value.slice(0, 16).replace('T', ' ') : '';
}
