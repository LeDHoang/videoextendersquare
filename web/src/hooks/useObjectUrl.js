import { useEffect, useState } from 'react';

// Creates a blob: URL for `file` and revokes it on cleanup / file change.
// `URL.createObjectURL` called directly in a render body (as this replaces)
// leaks a blob per render — nothing ever revoked it — and changes the
// <video>/<img> src identity every re-render, which can restart playback.
export function useObjectUrl(file) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
}
