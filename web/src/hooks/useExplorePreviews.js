import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const PREVIEW_BATCH = 24;
// The first request covers roughly one screen, so the tiles in view get previews before the rest are generated.
const FIRST_PREVIEW_BATCH = 8;

// A new videos array that starts with the previous one (a loaded page appended)
// adds its new tiles and keeps the previews already made and still being made.
export default function useExplorePreviews(videos) {
  const [items, setItems] = useState([]);
  const [previewMessage, setPreviewMessage] = useState('');
  const shown = useRef({ videos: [], run: 0 });

  useEffect(() => () => {
    shown.current.run += 1;
  }, []);

  useEffect(() => {
    const nextItems = Array.isArray(videos) ? videos : [];
    const before = shown.current.videos;
    const appended = before.length > 0 && nextItems.length > before.length
      && before.every((video, index) => nextItems[index] === video);
    const added = appended ? nextItems.slice(before.length) : nextItems;
    if (!appended) shown.current.run += 1;
    shown.current.videos = nextItems;
    const run = shown.current.run;
    const alive = () => shown.current.run === run;
    setItems(appended ? (current) => [...current, ...added] : nextItems);
    setPreviewMessage('');

    const missing = added
      .filter((video) => !video.preview_url || !video.poster_url)
      .map((video) => video.path);

    if (!missing.length) return;

    setPreviewMessage('LOADING PREVIEWS… 0/' + missing.length);

    (async () => {
      let done = 0;
      for (let index = 0; index < missing.length;) {
        const size = index === 0 ? FIRST_PREVIEW_BATCH : PREVIEW_BATCH;
        const batch = missing.slice(index, index + size);
        index += size;
        try {
          const response = await api.post('/api/reels/explore-preview', batch);
          const previews = response.generated || {};
          const posters = response.posters || {};
          if (alive() && (Object.keys(previews).length || Object.keys(posters).length)) {
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
        if (alive()) {
          setPreviewMessage('LOADING PREVIEWS… ' + Math.min(done, missing.length) + '/' + missing.length);
        }
      }
      if (alive()) setPreviewMessage('');
    })();
  }, [videos]);

  return { items, setItems, previewMessage };
}
