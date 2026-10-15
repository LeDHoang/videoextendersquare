import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

const PREVIEW_BATCH = 24;

export default function useExplorePreviews(videos) {
  const [items, setItems] = useState([]);
  const [previewMessage, setPreviewMessage] = useState('');

  useEffect(() => {
    let alive = true;
    const nextItems = Array.isArray(videos) ? videos : [];
    setItems(nextItems);
    setPreviewMessage('');

    const missing = nextItems
      .filter((video) => !video.preview_url || !video.poster_url)
      .map((video) => video.path);

    if (!missing.length) {
      return () => {
        alive = false;
      };
    }

    setPreviewMessage('LOADING PREVIEWS… 0/' + missing.length);

    (async () => {
      let done = 0;
      for (let index = 0; index < missing.length; index += PREVIEW_BATCH) {
        const batch = missing.slice(index, index + PREVIEW_BATCH);
        try {
          const response = await api.post('/api/reels/explore-preview', batch);
          const previews = response.generated || {};
          const posters = response.posters || {};
          if (alive && (Object.keys(previews).length || Object.keys(posters).length)) {
            setItems((current) => current.map((video) => {
              const previewUrl = previews[video.path];
              const posterUrl = posters[video.path];
              if (!previewUrl && !posterUrl) return video;
              return {
                ...video,
                ...(previewUrl ? { preview_url: previewUrl } : {}),
                ...(posterUrl ? { poster_url: posterUrl } : {}),
              };
            }));
          }
        } catch {
          /* Keep the poster/full-stream fallback for a failed preview batch. */
        }

        done += batch.length;
        if (alive) {
          setPreviewMessage('LOADING PREVIEWS… ' + Math.min(done, missing.length) + '/' + missing.length);
        }
      }
      if (alive) setPreviewMessage('');
    })();

    return () => {
      alive = false;
    };
  }, [videos]);

  return { items, setItems, previewMessage };
}
