import { useEffect, useRef, useState } from 'react';

// Free-text location with OpenStreetMap Nominatim matching.
//
// The user types anything; after a short debounce we offer up to 5
// normalized matches (city + country + lat/lon). Selecting one stores the
// full geo object for feed organization; leaving free text stores it as a
// raw city so publishing never blocks when offline. No API key needed.
export default function LocationField({ value, onChange }) {
  const [input, setInput] = useState(value?.display_name || value?.city || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef(null);

  // Keep the text in sync when the parent clears the form.
  useEffect(() => {
    if (!value || (!value.city && !value.display_name)) setInput('');
  }, [value]);

  useEffect(() => {
    const q = input.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return undefined;
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      setSearching(true);
      try {
        const url =
          'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=' +
          encodeURIComponent(q);
        const res = await fetch(url, {
          signal: ctl.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error('geo lookup failed');
        const rows = await res.json();
        if (!ctl.signal.aborted) {
          setSuggestions(Array.isArray(rows) ? rows : []);
          setOpen(true);
        }
      } catch {
        // Offline / rate-limited / aborted: stay in free-text mode.
        if (!ctl.signal.aborted) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      abortRef.current?.abort();
    };
  }, [input]);

  const pick = (row) => {
    const addr = row.address || {};
    const geo = {
      city:
        addr.city ||
        addr.town ||
        addr.village ||
        addr.municipality ||
        addr.county ||
        addr.state ||
        '',
      country: addr.country || '',
      display_name: row.display_name || '',
      lat: row.lat != null ? Number(row.lat) : null,
      lon: row.lon != null ? Number(row.lon) : null,
      osm_id: row.osm_id != null ? String(row.osm_id) : null,
    };
    setInput(geo.display_name);
    setOpen(false);
    onChange(geo);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="sx-input"
        placeholder="Add location… (e.g. Shibuya, Tokyo)"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          // Free text counts as a raw city until a match is picked.
          onChange({ city: e.target.value, country: '', display_name: '' });
        }}
        onFocus={() => {
          if (suggestions.length) setOpen(true);
        }}
        onBlur={() => {
          // Delay so a suggestion click registers before the panel closes.
          setTimeout(() => setOpen(false), 150);
        }}
        aria-label="Location"
        autoComplete="off"
      />
      {searching ? (
        <div className="sx-monospace-sm" style={{ marginTop: 4 }}>
          SEARCHING MAP…
        </div>
      ) : null}
      {open && suggestions.length > 0 ? (
        <div className="sx-location-panel" role="listbox" aria-label="Location suggestions">
          {suggestions.map((s) => (
            <button
              type="button"
              key={`${s.osm_type || 'n'}-${s.osm_id}`}
              role="option"
              aria-selected={false}
              className="sx-location-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              title={s.display_name}
            >
              {s.display_name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
