import { describe, expect, it } from 'vitest';
import {
  emptyDraft, formatLeft, groupProblem, mergeServerRenders, postSource, projectionOf, publishBody, restoredItem, shelfOf, sortItems,
  spatialOf, stagedItem, stereoOf, storedItem, timeLeft,
} from './mediaItems.js';

const meta = (name, width, height, extra = {}) => ({
  stage_id: `st-${name}`, filename: name, width, height,
  orientation: width > height ? 'LANDSCAPE' : height > width ? 'PORTRAIT' : 'SQUARE', ...extra,
});
const item = (name, width, height, extra = {}) => stagedItem({ name }, meta(name, width, height, extra), name.endsWith('.mp4') ? 'video' : 'image', 1000);
const ready = (jobId, extra = {}) => ({ jobId, status: 'ready', result: { download_url: `/d/${jobId}` }, ...extra });
const row = (jobId, extra = {}) => ({
  job_id: jobId, kind: 'image', role: 'square', source_stage_id: null, source_job_id: null, filename: 'beach.png',
  status: 'ready', kept: true, post_id: null, created_at: '2026-11-15T10:00:00+00:00', updated_at: '2026-11-15T10:05:00+00:00',
  expires_at: '2026-12-15T10:05:00+00:00', download_url: `/api/image/jobs/${jobId}/download`,
  media_url: `https://media.example.com/${jobId}.png`, thumb_url: `https://media.example.com/${jobId}-poster.jpg`, ...extra,
});
const SBS = { stereo: { candidate: 'sbs', detected: true } };

describe('shelves', () => {
  it('puts a file where its next step is', () => {
    const wide = item('wide.png', 1600, 900);
    expect(shelfOf(wide)).toBe('needs');
    expect(shelfOf(item('square.png', 512, 512))).toBe('ready');
    expect(shelfOf({ ...wide, render: { jobId: 'j1', status: 'working' } })).toBe('working');
    expect(shelfOf({ ...wide, render: ready('j1') })).toBe('ready');
    expect(shelfOf({ ...wide, render: { jobId: 'j1', status: 'failed' } })).toBe('needs');
    expect(shelfOf({ ...wide, render: ready('j1'), posted: { post_id: 'p1' } })).toBe('posted');
  });

  it('counts a file ready when it already has the target shape, or any shape for a null target', () => {
    const wide = item('wide.png', 1600, 900);
    const tall = item('tall.mp4', 1080, 1920);
    expect(shelfOf(wide, '16:9')).toBe('ready');
    expect(postSource(wide, '16:9')).toEqual({ stage_id: 'st-wide.png' });
    expect(shelfOf(wide, '9:16')).toBe('needs');
    expect(shelfOf(tall, '9:16')).toBe('ready');
    expect(shelfOf(item('square.png', 512, 512), '16:9')).toBe('needs');
    expect(shelfOf(item('odd.png', 1500, 1200), null)).toBe('ready');
    // Within 1% still counts as the shape.
    expect(shelfOf(item('near.png', 1910, 1080), '16:9')).toBe('ready');
  });

  it('posts a manual 9:8 / 8:9 stereo frame in 3D only with a picked layout', () => {
    const frame = item('pair.png', 2304, 2048);
    expect(frame.stereoOn).toBe(false);
    expect(stereoOf({ ...frame, stereoOn: true })).toBeNull();
    expect(stereoOf({ ...frame, stereoOn: true, stereoPick: 'sbs' })).toBe('sbs');
    expect(stereoOf({ ...frame, stereoOn: true, stereoPick: 'tb' })).toBe('tb');
    expect(shelfOf({ ...frame, stereoOn: true, stereoPick: 'tb' })).toBe('ready');
    expect(storedItem({ ...frame, stereoPick: 'tb' }).stereoPick).toBe('tb');
  });

  it('keeps a detected 3D upload ready while 3D is on, and sends it to be made square when off', () => {
    const eyes = item('eyes.png', 800, 400, SBS);
    expect(stereoOf(eyes)).toBe('sbs');
    expect(postSource(eyes)).toEqual({ stage_id: 'st-eyes.png' });
    expect(shelfOf({ ...eyes, stereoOn: false })).toBe('needs');
    expect(stereoOf({ ...eyes, render: ready('j1') })).toBeNull();
  });

  it('posts the 3D version over the square result over the upload', () => {
    const square = item('square.png', 512, 512);
    expect(postSource(square)).toEqual({ stage_id: 'st-square.png' });
    expect(postSource({ ...square, render: ready('j1') })).toEqual({ job_id: 'j1' });
    expect(postSource({ ...square, render: ready('j1'), convert: ready('j3d', { result: { stereo_layout: 'sbs' } }) }))
      .toEqual({ job_id: 'j3d', stereo_layout: 'sbs' });
    expect(postSource({ ...square, live: false })).toBeNull();
  });
});

describe('publishBody', () => {
  const draft = { title: ' Beach ', caption: 'c', tags: ['a'], location: { city: 'Hue' } };

  it('sends uploads as extra_stage_ids and switches to extra_items once a result is among them', () => {
    const [a, b, c] = ['a.png', 'b.png', 'c.png'].map((name) => item(name, 400, 400));
    expect(publishBody([c, b], draft, null)).toMatchObject({
      kind: 'image', title: 'Beach', caption: 'c', tags: ['a'], stage_id: 'st-c.png', extra_stage_ids: ['st-b.png'],
      location: { city: 'Hue', country: '', display_name: '', lat: null, lon: null, osm_id: null },
    });
    const body = publishBody([a, { ...b, render: ready('j-b') }, c], draft, ['s1', 's2', 's3']);
    expect(body.extra_items).toEqual([{ job_id: 'j-b' }, { stage_id: 'st-c.png' }]);
    expect(body.extra_stage_ids).toBeUndefined();
    expect(body.spatial_job_ids).toEqual(['s1', 's2', 's3']);
  });

  it('sends the 3D layout only for an as-is upload', () => {
    const eyes = item('eyes.png', 800, 400, SBS);
    expect(publishBody([eyes], draft, null)).toMatchObject({ stage_id: 'st-eyes.png', stereo_layout: 'sbs' });
    const flat = publishBody([{ ...eyes, render: ready('j1') }], draft, null);
    expect(flat.job_id).toBe('j1');
    expect(flat.stereo_layout).toBeUndefined();
    expect(flat.spatial_job_ids).toBeUndefined();
  });

  it('sends a 180/360 projection for videos: the pick, else the detected one', () => {
    const plain = item('clip.mp4', 1088, 1088);
    expect(publishBody([plain], draft, null).projection).toBeUndefined();
    const made = { ...plain, render: ready('j1'), projectionPick: 'equirect180' };
    expect(publishBody([made], draft, null)).toMatchObject({ job_id: 'j1', projection: 'equirect180' });
    const tagged = item('pano.mp4', 2048, 1024, { projection: { projection: 'equirect360', method: 'metadata' } });
    expect(projectionOf(tagged)).toBe('equirect360');
    expect(publishBody([{ ...tagged, projectionPick: 'flat' }], draft, null).projection).toBeUndefined();
    expect(projectionOf({ ...item('a.png', 400, 400), projectionPick: 'equirect360' })).toBe('flat');
    expect(projectionOf({ ...made, convert: ready('j3d') })).toBe('flat');
    expect(restoredItem(storedItem(made)).projectionPick).toBe('equirect180');
  });

  it('sends the visibility, public unless the draft is private', () => {
    const a = item('a.png', 400, 400);
    expect(publishBody([a], draft, null).visibility).toBe('public');
    expect(publishBody([a], { ...draft, visibility: 'private' }, null).visibility).toBe('private');
    expect(emptyDraft('t').visibility).toBe('public');
  });
});

describe('groupProblem', () => {
  it('allows 2 to 10 flat or same-layout images and names what blocks the rest', () => {
    const flat = ['a.png', 'b.png'].map((name) => item(name, 400, 400));
    const eyes = item('eyes.png', 800, 400, SBS);
    expect(groupProblem(flat)).toBe('');
    expect(groupProblem([eyes, item('eyes2.png', 800, 400, SBS)])).toBe('');
    expect(groupProblem([...flat, eyes])).toMatch(/3D and flat/);
    expect(groupProblem([...flat, item('clip.mp4', 480, 480)])).toBe('Images and videos can’t be posted together.');
    expect(groupProblem([item('a.mp4', 480, 480), item('b.mp4', 480, 480)])).toBe('A video can only be posted on its own.');
    expect(groupProblem(Array.from({ length: 11 }, (_, i) => item(`i${i}.png`, 400, 400)))).toMatch(/at most 10 images \(you picked 11\)/);
    expect(groupProblem([flat[0], { ...flat[1], convert: ready('j3d') }])).toMatch(/posted on its own/);
  });
});

describe('mergeServerRenders', () => {
  it('lists a result made elsewhere as its own ready tile', () => {
    const [made] = mergeServerRenders([], [row('j1')], []);
    expect(made).toMatchObject({ id: 'j1', name: 'beach.png', live: false, thumb: 'https://media.example.com/j1-poster.jpg' });
    expect(made.render).toMatchObject({ jobId: 'j1', status: 'ready', kept: true });
    expect(made.render.result).toEqual({ download_url: '/api/image/jobs/j1/download', preview_url: 'https://media.example.com/j1.png' });
    expect(shelfOf(made)).toBe('ready');
    expect(made.draft.title).toBe('beach');
  });

  it('keeps one tile per upload: a redo replaces the earlier result', () => {
    const wide = item('wide.png', 1600, 900);
    const merged = mergeServerRenders([wide], [
      row('j2', { source_stage_id: 'st-wide.png', created_at: '2026-11-15T11:00:00+00:00' }),
      row('j1', { source_stage_id: 'st-wide.png' }),
    ], [{ stage_id: 'st-wide.png', staged_at: '2026-11-15T09:00:00+00:00' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].render.jobId).toBe('j2');
    expect(merged[0].file).toBe(wide.file);
  });

  it('attaches 3D and depth versions to the item they were made from, never as tiles', () => {
    const merged = mergeServerRenders([], [
      row('j1'),
      row('j3d', { role: '3d', source_job_id: 'j1', created_at: '2026-11-15T10:10:00+00:00' }),
      row('jsp', { role: 'spatial', source_job_id: 'j1', created_at: '2026-11-15T10:11:00+00:00', updated_at: '2026-11-15T10:30:00+00:00' }),
      row('orphan', { role: '3d', source_job_id: 'gone' }),
    ], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].convert).toMatchObject({ jobId: 'j3d', status: 'ready', result: { stereo_layout: 'sbs' } });
    expect(spatialOf(merged[0])).toEqual({ source: 'j1', jobId: 'jsp', status: 'done' });
    expect(merged[0].lastActionAt).toBe(Date.parse('2026-11-15T10:30:00+00:00'));
  });

  it('marks a posted result and makes no tile for a failed job with nothing left', () => {
    const merged = mergeServerRenders([], [row('j1', { post_id: 'post-1' }), row('j2', { status: 'failed' })], []);
    expect(merged.map((entry) => entry.id)).toEqual(['j1']);
    expect(shelfOf(merged[0])).toBe('posted');
  });

  it('shows a failed job on the upload that is still here', () => {
    const wide = item('wide.png', 1600, 900);
    const [merged] = mergeServerRenders([wide], [row('j1', { source_stage_id: 'st-wide.png', status: 'failed' })], []);
    expect(merged.render.status).toBe('failed');
    expect(shelfOf(merged)).toBe('needs');
  });

  it('does not overwrite a job this page is following', () => {
    const wide = item('wide.png', 1600, 900);
    const local = { ...wide, render: ready('j1', { result: { download_url: '/local' } }) };
    const [same] = mergeServerRenders([local], [row('j1', { source_stage_id: 'st-wide.png' })], []);
    expect(same.render).toMatchObject({ result: { download_url: '/local' }, kept: true, expiresAt: Date.parse('2026-12-15T10:05:00+00:00') });
    const newer = { ...wide, render: { jobId: 'j9', status: 'working', startedAt: Date.parse('2026-11-15T12:00:00+00:00') } };
    expect(mergeServerRenders([newer], [row('j1', { source_stage_id: 'st-wide.png' })], [])[0].render.jobId).toBe('j9');
  });

  it('drops a restored upload the server no longer holds, and keeps one staged this visit', () => {
    const gone = restoredItem(storedItem(item('gone.png', 1600, 900)));
    const alive = restoredItem(storedItem(item('alive.png', 1600, 900)));
    const fresh = item('fresh.png', 1600, 900);
    const merged = mergeServerRenders([gone, alive, fresh], [], [{ stage_id: 'st-alive.png', staged_at: '2026-11-15T09:00:00+00:00' }]);
    expect(merged.map((entry) => entry.id)).toEqual(['st-alive.png', 'st-fresh.png']);
    expect(merged[0]).toMatchObject({ live: true, stagedAt: Date.parse('2026-11-15T09:00:00+00:00') });
  });
});

describe('sorting and time left', () => {
  it('sorts by time added or by last action, newest first', () => {
    const list = [{ id: 'a', addedAt: 1, lastActionAt: 9 }, { id: 'b', addedAt: 2, lastActionAt: 3 }];
    expect(sortItems(list, 'added').map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(sortItems(list, 'last_action').map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('counts an upload down from when it was staged and a result down to its expiry', () => {
    const retention = { stage_seconds: 6 * 3600, result_seconds: 30 * 86400 };
    const wide = item('wide.png', 1600, 900);
    expect(timeLeft(wide, retention, 1000 + 3 * 3600 * 1000)).toEqual({ ms: 3 * 3600 * 1000, fraction: 0.5 });
    expect(timeLeft(wide, retention, 1000 + 7 * 3600 * 1000)).toEqual({ ms: 0, fraction: 0 });
    const kept = { ...wide, render: ready('j1', { kept: true, expiresAt: 15 * 86400 * 1000 }) };
    expect(timeLeft(kept, retention, 0)).toEqual({ ms: 15 * 86400 * 1000, fraction: 0.5 });
    expect(timeLeft({ ...kept, posted: { post_id: 'p' } }, retention, 0)).toBeNull();
    expect(timeLeft(wide, null, 0)).toBeNull();
  });

  it('words the time left', () => {
    expect(formatLeft(27 * 86400 * 1000)).toBe('27 days left');
    expect(formatLeft((5 * 60 + 12) * 60000)).toBe('5 h 12 min left');
    expect(formatLeft(12 * 60000 + 59000)).toBe('12 min left');
  });
});
