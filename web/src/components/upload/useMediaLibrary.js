import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { mergeServerRenders, restoredItem, storedItem } from './mediaItems.js';

const STORE_KEY = 'sx.upload.items';
const THUMB_SIDE = 320;

function loadStored() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => entry?.id).map(restoredItem) : [];
  } catch {
    return [];
  }
}

function saveStored(items) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.filter((item) => !item.posted).map(storedItem)));
  } catch {
    /* storage full or blocked: the list still works for this visit */
  }
}

// A small JPEG of an image file, so its tile survives a reload. Resolves null
// where it cannot be drawn.
async function imageThumb(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

// The Upload page's media list: what this device remembers, with the person's
// job results from the server folded in (GET /api/uploads/mine).
export function useMediaLibrary() {
  const [items, setItems] = useState(loadStored);
  // { stage_seconds, result_seconds } once the server has answered.
  const [retention, setRetention] = useState(null);

  const reload = useCallback(async () => {
    try {
      const body = await api.get('/api/uploads/mine');
      // A failed or odd answer leaves the list as it is.
      if (!Array.isArray(body?.items) || !Array.isArray(body?.stages)) return;
      setRetention(body.retention || null);
      setItems((current) => mergeServerRenders(current, body.items, body.stages));
    } catch {
      /* offline: keep what is here */
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    saveStored(items);
  }, [items]);

  const patch = useCallback((id, change) => {
    setItems((current) => current.map((item) => (
      item.id === id ? { ...item, ...(typeof change === 'function' ? change(item) : change) } : item
    )));
  }, []);

  const add = useCallback((added) => {
    setItems((current) => [...added, ...current.filter((item) => !added.some((entry) => entry.id === item.id))]);
    for (const item of added) {
      if (item.kind === 'image' && item.file) {
        imageThumb(item.file).then((thumb) => {
          if (thumb) patch(item.id, { thumb });
        });
      }
    }
  }, [patch]);

  const remove = useCallback((id) => {
    setItems((current) => {
      const gone = current.find((item) => item.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  return { items, retention, reload, patch, add, remove };
}
