// Fetch wrapper — dev (Vite proxy) and prod (same origin) both use relative URLs.

async function handle(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  get(path, params) {
    const q = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
        ).toString()
      : '';
    return fetch(path + q).then(handle);
  },
  post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(handle);
  },
  put(path, body) {
    return fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(handle);
  },
  form(path, formData) {
    return fetch(path, { method: 'POST', body: formData }).then(handle);
  },
  upload(path, file, field = 'file') {
    const fd = new FormData();
    fd.append(field, file);
    return fetch(path, { method: 'POST', body: fd }).then(handle);
  },
};