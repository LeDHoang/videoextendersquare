import { stereoCandidate } from '../../utils/mediaFormat.js';
import { matchesTarget } from '../../utils/cloudBilling.js';

// The Upload page's media list. One item is one file the person added, with the
// jobs made from it: `render` (filled or upscaled), `convert` (MAKE 3D) and `spatial`
// (the depth version published beside a 2D post). Everything here is pure.
//
// item: { id, kind, name, addedAt, lastActionAt, meta, live, stagedAt, file, url,
//         thumb, stereoOn, stereoPick, projectionPick, checked, draft, render, convert, spatial, posted }
// job:  { jobId, status: 'working' | 'ready' | 'failed' | 'cancelled', result,
//         state, startedAt, kept, expiresAt }

export const TITLE_MAX = 100;
export const CAPTION_MAX = 2200;
export const TAGS_MAX = 5;
// One post is either a single video or 1–10 images, never both.
export const MAX_POST_IMAGES = 10;
export const ACCEPT = '.png,.jpg,.jpeg,.webp,.mp4,.mov,.avi,.webm';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm'];

export function kindOf(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

export const isSquareMeta = (meta) => !!meta && (meta.orientation === 'SQUARE' || (!!meta.width && meta.width === meta.height));
// Stereo layout a staged upload could hold: the server's detection block, or
// the frame geometry for older stage responses.
export const metaStereoCandidate = (meta) => meta?.stereo?.candidate || stereoCandidate(meta?.width, meta?.height);
export const metaStereoDetected = (meta) => !!(meta?.stereo?.detected && metaStereoCandidate(meta));
// Whether the file already has `target` ('1:1' | '16:9' | '9:16'; null: any shape).
const metaMatches = (meta, target) => (target === '1:1' && isSquareMeta(meta)) || matchesTarget(meta, target);
export const titleFromName = (name) => (name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, TITLE_MAX);

export const emptyDraft = (title = '') => ({ title, caption: '', tags: [], location: { city: '', country: '', display_name: '' }, visibility: 'public' });

export function stagedItem(file, meta, kind, now) {
  return {
    id: meta.stage_id,
    kind,
    name: file.name,
    addedAt: now,
    lastActionAt: now,
    meta,
    live: true,
    stagedAt: now,
    file,
    url: null,
    thumb: null,
    stereoOn: metaStereoDetected(meta),
    stereoPick: null,
    projectionPick: null,
    checked: true,
    draft: emptyDraft(titleFromName(file.name)),
    render: null,
    convert: null,
    spatial: null,
    posted: null,
  };
}

// The 3D layout an as-is upload is published with, or null: the person's SBS/TB
// pick for a 9:8 / 8:9 frame, else the detected one. A made result is always flat.
export function stereoOf(item) {
  if (!item.stereoOn || !item.live || item.render?.status === 'ready') return null;
  return item.stereoPick || metaStereoCandidate(item.meta) || null;
}

export const PROJECTIONS = ['flat', 'equirect180', 'equirect360'];
// How a video is shown in VR: the person's pick, else the file's spherical
// metadata, else flat. Images and a MAKE 3D result are always flat.
export function projectionOf(item) {
  if (item.kind !== 'video' || item.convert?.status === 'ready') return 'flat';
  return item.projectionPick || item.meta?.projection?.projection || 'flat';
}

// A 180° or 360° video keeps its panorama only in its own shape: it posts as it
// is, or upscaled under Original. Extend, a depth version or MAKE 3D would break it.
export const isSpherical = (item) => projectionOf(item) !== 'flat';
// The shape `item` must already have to post as it is (see postSource), with its kind's options.
export const asIsTargetOf = (item, cfg) => (isSpherical(item) ? (cfg.noUpscale ? null : false) : cfg.asIsShapeFor(item.meta));

// What a post of this item points at, or null while it still needs to be made.
// `target` is the shape a live upload must already have to post as it is
// (null: any shape; false: none, an upscale is picked).
export function postSource(item, target = '1:1') {
  if (item.convert?.status === 'ready') return { job_id: item.convert.jobId, stereo_layout: item.convert.result?.stereo_layout };
  if (item.render?.status === 'ready') return { job_id: item.render.jobId };
  if (item.live && item.meta && ((target !== false && metaMatches(item.meta, target)) || stereoOf(item))) return { stage_id: item.meta.stage_id };
  return null;
}

export function shelfOf(item, target = '1:1') {
  if (item.posted) return 'posted';
  if (item.render?.status === 'working') return 'working';
  return postSource(item, target) ? 'ready' : 'needs';
}

// The file a spatial (depth) version is made from: the made result, else the upload.
export const spatialSource = (item) => (item.render?.status === 'ready' ? { job_id: item.render.jobId } : { stage_id: item.id });
export function spatialOf(item) {
  const source = spatialSource(item);
  return item.spatial && item.spatial.source === (source.job_id || source.stage_id) ? item.spatial : null;
}

// Why these items cannot be one post, or ''.
export function groupProblem(items) {
  const videos = items.filter((item) => item.kind === 'video').length;
  if (videos && videos < items.length) return 'Images and videos can’t be posted together.';
  if (videos) return 'A video can only be posted on its own.';
  if (items.length > MAX_POST_IMAGES) return `A post holds at most ${MAX_POST_IMAGES} images (you picked ${items.length}).`;
  if (items.some((item) => item.convert)) return 'An image made 3D is posted on its own.';
  if (new Set(items.map((item) => stereoOf(item) || 'flat')).size > 1) return '3D and flat images cannot share a post.';
  return '';
}

// The body of POST /api/uploads/publish. `items` are in post order (the first is
// the cover) and all ready to post; `spatialJobIds` is every slide's depth version, or null.
export function publishBody(items, draft, spatialJobIds) {
  const [cover, ...rest] = items;
  const source = postSource(cover, null);
  const extras = rest.map((item) => postSource(item, null));
  const stereo = stereoOf(cover);
  const projection = projectionOf(cover);
  const location = draft.location;
  return {
    kind: cover.kind,
    title: draft.title.trim(),
    caption: draft.caption,
    tags: draft.tags,
    location: {
      city: location?.city || '',
      country: location?.country || '',
      display_name: location?.display_name || '',
      lat: location?.lat ?? null,
      lon: location?.lon ?? null,
      osm_id: location?.osm_id ?? null,
    },
    visibility: draft.visibility || 'public',
    ...source,
    ...(!extras.length ? {}
      : extras.every((extra) => extra.stage_id)
        ? { extra_stage_ids: extras.map((extra) => extra.stage_id) }
        : { extra_items: extras.map((extra) => (extra.stage_id ? { stage_id: extra.stage_id } : { job_id: extra.job_id })) }),
    ...(stereo && source.stage_id ? { stereo_layout: stereo } : {}),
    ...(projection !== 'flat' ? { projection } : {}),
    // All slides or none: a failed spatial job publishes the post 2D only.
    ...(spatialJobIds ? { spatial_job_ids: spatialJobIds } : {}),
  };
}

const ROW_STATUS = { working: 'working', ready: 'ready', failed: 'failed', cancelled: 'cancelled' };

function jobFromRow(row) {
  return {
    jobId: row.job_id,
    status: ROW_STATUS[row.status] || 'failed',
    startedAt: Date.parse(row.created_at),
    kept: row.kept,
    expiresAt: row.expires_at ? Date.parse(row.expires_at) : null,
    // media_url is the browser-playable copy (the H.264 preview of a video).
    result: row.status === 'ready'
      ? { download_url: row.download_url, preview_url: row.media_url, ...(row.role === '3d' ? { stereo_layout: 'sbs' } : {}) }
      : null,
  };
}

// A job this page started and still knows more about than the row does.
function keepLocal(local, row) {
  if (!local) return null;
  if (local.jobId === row.job_id) {
    return local.status === 'ready' ? { ...jobFromRow(row), status: 'ready', result: local.result } : local.status === 'working' ? local : null;
  }
  return (local.startedAt || 0) > Date.parse(row.created_at) ? local : null;
}

// Fold GET /api/uploads/mine into the list. A `square` row is a tile (one per
// upload: a redo replaces the earlier result). A `3d` or `spatial` row is never
// a tile: it attaches to the item it was made from. A failed row only marks an
// item that is still here. Items restored from this device's storage are
// dropped when the server holds neither their upload nor a result of it.
export function mergeServerRenders(items, rows, stages) {
  const stageById = new Map(stages.map((stage) => [stage.stage_id, stage]));
  const byId = new Map(items.map((item) => [item.id, item.restored
    ? { ...item, live: stageById.has(item.id), stagedAt: stageById.has(item.id) ? Date.parse(stageById.get(item.id).staged_at) : item.stagedAt }
    : item]));
  const ordered = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const touch = (item, row) => ({
    ...item,
    lastActionAt: Math.max(item.lastActionAt || 0, Date.parse(row.updated_at)),
    ...(row.post_id && !item.posted ? { posted: { post_id: row.post_id } } : {}),
  });

  for (const row of ordered.filter((entry) => entry.role === 'square')) {
    const id = row.source_stage_id || row.job_id;
    const existing = byId.get(id);
    if (!existing && row.status !== 'ready' && row.status !== 'working') continue;
    const base = existing || {
      id,
      kind: row.kind,
      name: row.filename || 'Untitled',
      addedAt: Date.parse(row.created_at),
      lastActionAt: 0,
      meta: null,
      live: false,
      stagedAt: null,
      file: null,
      url: null,
      thumb: null,
      stereoOn: false,
      checked: false,
      draft: emptyDraft(titleFromName(row.filename || '')),
      render: null,
      convert: null,
      spatial: null,
      posted: null,
    };
    const render = keepLocal(base.render, row) || jobFromRow(row);
    byId.set(id, touch({ ...base, render, thumb: row.thumb_url || base.thumb }, row));
  }

  for (const row of ordered.filter((entry) => entry.role !== 'square')) {
    const owner = [...byId.values()].find((item) => (
      (row.source_job_id && item.render?.jobId === row.source_job_id) || (row.source_stage_id && item.id === row.source_stage_id)
    ));
    if (!owner) continue;
    const source = row.source_job_id || row.source_stage_id;
    if (row.role === '3d') {
      if (row.status !== 'ready' && row.status !== 'working') continue;
      byId.set(owner.id, touch({ ...owner, convert: keepLocal(owner.convert, row) || jobFromRow(row) }, row));
    } else if (!owner.spatial || owner.spatial.jobId === row.job_id || owner.spatial.source !== source) {
      const status = row.status === 'ready' ? 'done' : row.status === 'working' ? 'running' : 'failed';
      byId.set(owner.id, touch({ ...owner, spatial: { source, jobId: row.job_id, status } }, row));
    }
  }

  return [...byId.values()].filter((item) => !item.restored || item.live || item.render || item.posted);
}

export function sortItems(items, mode) {
  const key = mode === 'added' ? 'addedAt' : 'lastActionAt';
  return [...items].sort((a, b) => (b[key] || 0) - (a[key] || 0));
}

// How long the server still keeps this item's file: { ms, fraction } (fraction
// of its whole window left), or null for a posted item (kept for good) and for
// one whose limits are not known.
export function timeLeft(item, retention, now) {
  if (item.posted || !retention) return null;
  const job = item.convert?.status === 'ready' ? item.convert : item.render?.status === 'ready' ? item.render : null;
  let ends;
  let total;
  if (job) {
    if (!job.expiresAt) return null;
    ends = job.expiresAt;
    total = (job.kept ? retention.result_seconds : retention.stage_seconds) * 1000;
  } else if (item.live && item.stagedAt) {
    total = retention.stage_seconds * 1000;
    ends = item.stagedAt + total;
  } else {
    return null;
  }
  const ms = Math.max(0, ends - now);
  return { ms, fraction: total > 0 ? Math.min(1, ms / total) : 0 };
}

export function formatLeft(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 48 * 60) return `${Math.floor(minutes / 1440)} days left`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
  return `${minutes} min left`;
}

// What this device remembers of an unposted item between visits.
export function storedItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    addedAt: item.addedAt,
    lastActionAt: item.lastActionAt,
    meta: item.meta,
    stagedAt: item.stagedAt,
    thumb: item.thumb,
    stereoOn: item.stereoOn,
    stereoPick: item.stereoPick,
    projectionPick: item.projectionPick,
    draft: item.draft,
  };
}

export function restoredItem(stored) {
  return {
    ...stored,
    restored: true,
    live: false,
    file: null,
    url: null,
    checked: false,
    render: null,
    convert: null,
    spatial: null,
    posted: null,
  };
}
