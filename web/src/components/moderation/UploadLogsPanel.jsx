import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Button } from '../ui/controls.jsx';
import { EmptyState, Mono } from '../ui/primitives.jsx';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import { usePagedList, when } from './usePagedList.js';

const STATUSES = ['staged', 'processing', 'processed', 'failed', 'cancelled', 'published', 'publish_failed'];
const SORTS = [
  { value: 'created_at', label: 'UPLOADED' },
  { value: 'updated_at', label: 'LAST EVENT' },
  { value: 'process_ms', label: 'PROCESS TIME' },
  { value: 'cost', label: 'COST' },
  { value: 'size_bytes', label: 'SIZE' },
];
// Event fields already shown on the timeline line itself.
const SHOWN = new Set(['event', 'at']);

function size(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function seconds(ms) {
  return ms == null ? '' : (ms / 1000).toFixed(1) + ' s';
}

function eventDetail(event) {
  const rest = Object.fromEntries(Object.entries(event).filter(([key]) => !SHOWN.has(key)));
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
}

function FilePreview({ file }) {
  const type = file.content_type || '';
  return (
    <div className="sx-upload-file">
      {!file.url ? null : type.startsWith('video/') ? <video src={file.url} controls preload="metadata" />
        : type.startsWith('image/') ? <img src={file.url} alt={file.role + ' file'} /> : null}
      <Mono>
        {file.role.toUpperCase()} · {file.filename}{file.size_bytes != null ? ' · ' + size(file.size_bytes) : ''} ·{' '}
        {file.url
          ? <a className="sx-staff-link" href={file.url} target="_blank" rel="noreferrer" download={file.filename}>DOWNLOAD</a>
          : file.expired ? 'EXPIRED (JOB RESULTS ARE DELETED AFTER 30 DAYS)' : 'LINK UNAVAILABLE'}
      </Mono>
    </div>
  );
}

function TraceDetail({ id }) {
  const [state, setState] = useState({ data: null, error: '' });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: '' });
    api.get('/api/admin/upload-logs/trace/' + encodeURIComponent(id)).then(
      (data) => { if (live) setState({ data, error: '' }); },
      (error) => { if (live) setState({ data: null, error: error.message || 'Could not load this upload.' }); },
    );
    return () => { live = false; };
  }, [id]);
  if (state.error) return <div className="sx-error-box" role="alert">{state.error}</div>;
  if (!state.data) return <SectionSkeleton label="Loading upload trace" />;
  const { files, trace } = state.data;
  return (
    <div className="sx-upload-detail">
      {files.length ? files.map((file) => <FilePreview key={file.role} file={file} />) : <Mono>NO FILES KEPT FOR THIS UPLOAD</Mono>}
      {trace ? (
        <ol className="sx-upload-events">
          {trace.events.map((event, index) => (
            <li key={index}>
              <Mono>{when(event.at)}{event.at ? event.at.slice(16, 23) : ''} · <strong>{event.event}</strong>{event.ms != null ? ' · ' + seconds(event.ms) : ''}</Mono>
              {eventDetail(event) ? <pre>{eventDetail(event)}</pre> : null}
            </li>
          ))}
        </ol>
      ) : <Mono>THE TRACE FILE IS MISSING</Mono>}
    </div>
  );
}

/** Moderators: every upload's trace (steps, timings, errors), its kept source file and its job result. */
export default function UploadLogsPanel({ onOpenUser }) {
  const [draft, setDraft] = useState({ q: '', user: '' });
  const [filters, setFilters] = useState({ q: '', user: '' });
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState('created_at');
  const [order, setOrder] = useState('desc');
  const [open, setOpen] = useState('');
  const list = usePagedList('/api/admin/upload-logs', { ...filters, status, kind, sort, order, limit: 25 });

  return (
    <div>
      <form
        className="sx-staff-search"
        role="search"
        onSubmit={(event) => { event.preventDefault(); setFilters({ q: draft.q.trim(), user: draft.user.trim() }); }}
      >
        <input className="sx-ps-input" aria-label="Filename or id" placeholder="Filename, upload, job or post id" value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} />
        <input className="sx-ps-input" aria-label="Uploader" placeholder="@user" value={draft.user} onChange={(event) => setDraft({ ...draft, user: event.target.value })} />
        <select className="sx-ps-input" aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">ANY STATUS</option>
          {STATUSES.map((value) => <option key={value} value={value}>{value.toUpperCase().replace('_', ' ')}</option>)}
        </select>
        <select className="sx-ps-input" aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">VIDEO + IMAGE</option>
          <option value="video">VIDEO</option>
          <option value="image">IMAGE</option>
        </select>
        <select className="sx-ps-input" aria-label="Sort by" value={sort} onChange={(event) => setSort(event.target.value)}>
          {SORTS.map((option) => <option key={option.value} value={option.value}>SORT: {option.label}</option>)}
        </select>
        <Button type="button" onClick={() => setOrder(order === 'desc' ? 'asc' : 'desc')} aria-label="Sort order">
          {order === 'desc' ? 'HIGH → LOW' : 'LOW → HIGH'}
        </Button>
        <Button type="submit">FILTER</Button>
      </form>
      {list.error ? <div className="sx-error-box" role="alert">{list.error}</div> : null}
      {list.items === null ? <SectionSkeleton label="Loading upload logs" /> : list.items.length ? (
        <ul className="sx-staff-rows">
          {list.items.map((row) => (
            <li key={row.id} className="sx-staff-item">
              <div>
                <button type="button" className="sx-staff-link" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? '' : row.id)}>
                  <strong>{row.filename || row.id}</strong>
                </button>{' '}
                <Mono>{row.status.toUpperCase().replace('_', ' ')}</Mono>
                <Mono>
                  {when(row.created_at)} · {(row.kind || '?').toUpperCase()} ·{' '}
                  {row.user_id
                    ? <button type="button" className="sx-staff-link" onClick={() => onOpenUser(row.user_id)}>{row.username ? '@' + row.username : row.user_id}</button>
                    : 'NO USER'}
                  {row.size_bytes != null ? ' · ' + size(row.size_bytes) : ''}
                  {row.process_ms != null ? ' · ' + seconds(row.process_ms) : ''}
                  {row.cost != null ? ' · $' + row.cost.toFixed(2) : ''}
                  {' · ' + row.file_count + (row.file_count === 1 ? ' FILE' : ' FILES')}
                </Mono>
                <Mono>UPLOAD {row.id}{row.job_id ? ' · JOB ' + row.job_id : ''}{row.post_id ? ' · POST ' + row.post_id : ''}</Mono>
                {row.error ? <p className="sx-upload-error">{row.error}</p> : null}
              </div>
              {open === row.id ? <TraceDetail id={row.id} /> : null}
            </li>
          ))}
        </ul>
      ) : <EmptyState title="NO UPLOADS" text="No upload matches these filters." />}
      {list.hasMore ? <Button onClick={list.more} loading={list.loadingMore}>LOAD MORE</Button> : null}
    </div>
  );
}
