// Fetch wrapper shared by development (Vite proxy) and production.

export class ApiError extends Error {
  constructor(message, status, code, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.detail = detail;
  }
}

function cookie(name) {
  if (typeof document === 'undefined') return '';
  const prefix = name + '=';
  const row = document.cookie.split('; ').find((part) => part.startsWith(prefix));
  return row ? decodeURIComponent(row.slice(prefix.length)) : '';
}

async function handle(res) {
  if (res.status === 204) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.detail ?? body;
    const message =
      (detail && typeof detail === 'object' && detail.message) ||
      (typeof detail === 'string' ? detail : '') ||
      res.statusText ||
      'Request failed';
    const code = detail && typeof detail === 'object' ? detail.code : null;
    throw new ApiError(message, res.status, code, detail);
  }
  return body;
}

function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = cookie('echo_csrf');
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  return fetch(path, {
    ...options,
    method,
    headers,
    credentials: 'include',
  }).then(handle);
}

export const api = {
  get(path, params) {
    const q = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
        ).toString()
      : '';
    return request(path + q);
  },
  post(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  },
  put(path, body) {
    return request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  },
  patch(path, body) {
    return request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  },
  delete(path, body) {
    return request(path, {
      method: 'DELETE',
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  },
  form(path, formData, method = 'POST') {
    return request(path, { method, body: formData });
  },
  upload(path, file, field = 'file') {
    const formData = new FormData();
    formData.append(field, file);
    return request(path, { method: 'POST', body: formData });
  },
};
