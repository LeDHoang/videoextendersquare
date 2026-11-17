import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { BlockingBanner, Hero, probeLine } from '../components/ui/primitives.jsx';
import { Button, Segmented, Tabs } from '../components/ui/controls.jsx';
import Dialog from '../components/ui/Dialog.jsx';
import IconButton from '../components/ui/IconButton.jsx';
import UploadZone from '../components/ui/UploadZone.jsx';
import { useHealthContext } from '../hooks/HealthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';
import { appendProcessingParameters } from '../utils/cloudBilling.js';
import { billingErrorMessage } from '../utils/billingErrors.js';
import { assertUploadSize } from '../utils/uploadLimits.js';
import { ActivityIcon, ClockIcon, CloseIcon, SlidersIcon, IndustrialUploadIcon, SquareIcon, StackIcon } from '../components/icons/index.jsx';
import { useImageExtendConfig, useVideoExtendConfig } from '../components/upload/useExtendConfig.js';
import { useRenderFunding } from '../components/upload/useRenderFunding.js';
import { useMediaLibrary } from '../components/upload/useMediaLibrary.js';
import JobWatcher from '../components/upload/JobWatcher.jsx';
import MediaTile from '../components/upload/MediaTile.jsx';
import MediaDialog from '../components/upload/MediaDialog.jsx';
import OptionsPanel from '../components/upload/OptionsPanel.jsx';
import {
  ACCEPT, groupProblem, isSquareMeta, kindOf, postSource, publishBody, shelfOf, sortItems, spatialOf, spatialSource, stagedItem, stereoOf,
} from '../components/upload/mediaItems.js';

// Upload: the person's media, grouped by what each file needs next. Files that
// are not square wait on the first shelf to be made square; square files and
// finished results wait on the second to be posted. The Gallery tab lists
// everything by time.

const KINDS = ['image', 'video'];
const KIND_TABS = ['IMAGES', 'VIDEOS'];
const TABS = [{ value: 'todo', label: 'To do' }, { value: 'gallery', label: 'Gallery' }];

export default function UploadPage() {
  const { user } = useAuth();
  const { wallet, catalog, falKey, refresh: refreshWallet } = useWallet();
  const health = useHealthContext();
  const cfgCtx = useConfigContext();
  const probes = health?.probes || {};
  const studioOk = probes.vapoursynth?.ok && probes.ffms2?.ok && probes.znedi3?.ok;
  const models = cfgCtx?.config?.models || {};
  const features = cfgCtx?.config?.features || {};

  // Each kind keeps its own settings for the whole visit.
  const cfgs = { image: useImageExtendConfig(models), video: useVideoExtendConfig(models) };
  const { items, retention, reload, patch, add, remove } = useMediaLibrary();

  const [tab, setTab] = useState('todo');
  const [sort, setSort] = useState('added');
  const [staging, setStaging] = useState(0);
  const [pickError, setPickError] = useState('');
  // The open dialog: { ids (post order), view, redo, draft (several images) }.
  const [open, setOpen] = useState(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsKind, setOptionsKind] = useState('image');
  const [progress, setProgress] = useState({});
  const [makeBusy, setMakeBusy] = useState(false);
  const [makeError, setMakeError] = useState('');
  // The server runs a few jobs per person at a time. Files it refused for that
  // reason stay checked and start by themselves when a running job ends.
  const [waiting, setWaiting] = useState(false);
  const [settled, setSettled] = useState(0);
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [spatialOff, setSpatialOff] = useState(false);
  const spatialStarting = useRef(false);
  const [publishing, setPublishing] = useState(false);
  const [postError, setPostError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const byShelf = { needs: [], working: [], ready: [], posted: [] };
  for (const item of sortItems(items, 'added')) byShelf[shelfOf(item)].push(item);
  const openItems = open ? open.ids.map((id) => items.find((item) => item.id === id)).filter(Boolean) : [];
  const cover = openItems[0] || null;
  const group = openItems.length > 1;
  // The options show for a file that still needs to be made square, or one being redone.
  const makeMode = !!cover && !group && !cover.posted && cover.live && shelfOf(cover) !== 'working' && (shelfOf(cover) === 'needs' || !!open.redo);

  // What the Make button acts on: the open file, else the checked files of the first shelf.
  const targets = makeMode ? [cover] : byShelf.needs.filter((item) => item.checked && item.live);
  const fundingOf = (kind) => ({
    kind, items: targets.filter((item) => item.kind === kind).map((item) => item.meta), config: cfgs[kind], user, wallet, catalog, falKey,
  });
  const fundings = { image: useRenderFunding(fundingOf('image')), video: useRenderFunding(fundingOf('video')) };
  const targetKinds = KINDS.filter((kind) => targets.some((item) => item.kind === kind));
  // One payment choice for both kinds.
  const setPaymentSource = (source) => KINDS.forEach((kind) => fundings[kind].setPaymentSource(source));
  const priceOf = (item) => {
    const funding = fundings[item.kind];
    if (funding.paymentSource !== 'credits') return null;
    return funding.quoteState.quotes.find((quote) => quote.stage_id === item.id)?.credits ?? null;
  };
  const totalCredits = targetKinds.reduce((sum, kind) => (
    sum + (fundings[kind].cloudRequired && fundings[kind].paymentSource === 'credits' ? fundings[kind].quoteState.totalCredits : 0)
  ), 0);

  const blockedIds = items.some((item) => item.kind === 'video') ? ['ffmpeg', 'ffprobe', 'encoder'] : ['ffmpeg', 'ffprobe'];
  const blocked = blockedIds.filter((id) => probes[id] && !probes[id].ok).map((id) => probes[id]);
  const studioBlocked = targetKinds.includes('video') && cfgs.video.studioPicked && !studioOk;
  const fundingBlocked = targetKinds.some((kind) => fundings[kind].fundingBlocked);
  const quoteStale = targetKinds.some((kind) => fundings[kind].quoteStale);
  // Already-square files have nothing to fill or stretch; with no upscale (and no trim) nothing would change.
  const squareOnly = targets.length > 0 && targets.every((item) => isSquareMeta(item.meta));
  const nothingToDo = squareOnly && targets.every((item) => cfgs[item.kind].noUpscale && !(item.kind === 'video' && cfgs.video.trimEnabled));

  // ── Adding files ──
  const onFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setPickError('');
    const unsupported = list.find((entry) => !kindOf(entry.name));
    if (unsupported) {
      setPickError(`Unsupported file type: ${unsupported.name}. Use PNG/JPG/WEBP or MP4/MOV/AVI/WEBM.`);
      return;
    }
    setStaging((count) => count + list.length);
    // One time for the whole pick, so the files keep the order they were picked in.
    const addedAt = Date.now();
    const errors = [];
    const staged = (await Promise.all(list.map(async (file) => {
      const kind = kindOf(file.name);
      try {
        assertUploadSize(file, kind, cfgCtx?.config);
        const meta = await api.upload(kind === 'image' ? '/api/image/upload' : '/api/video/upload', file);
        return { ...stagedItem(file, meta, kind, addedAt), url: URL.createObjectURL(file) };
      } catch (e) {
        errors.push(`Could not add ${file.name}: ${billingErrorMessage(e)}`);
        return null;
      } finally {
        setStaging((count) => count - 1);
      }
    }))).filter(Boolean);
    if (errors.length) setPickError(errors.join(' '));
    if (!staged.length) return;
    // New files arrive checked; earlier checks are cleared so an action covers what was just added.
    items.forEach((item) => item.checked && patch(item.id, { checked: false }));
    add(staged);
    if (staged.length === 1) openItem(staged[0]);
  };

  const openItem = (item) => {
    setPostError('');
    setConvertError('');
    setMakeError('');
    setOpen({ ids: [item.id], view: item.id, redo: false });
  };

  const step = (delta) => {
    const row = tab === 'gallery' ? sortItems(items, sort) : [...byShelf.needs, ...byShelf.working, ...byShelf.ready, ...byShelf.posted];
    const index = row.findIndex((item) => item.id === cover.id);
    openItem(row[(index + delta + row.length) % row.length]);
  };

  // ── Make square ──
  const processForm = (kind, meta, quoteByStage, name) => {
    const funding = fundings[kind];
    const fd = new FormData();
    fd.append('stage_id', meta.stage_id);
    appendProcessingParameters(fd, cfgs[kind].parameters);
    if (funding.needsCloud(meta)) {
      fd.append('payment_source', funding.paymentSource);
      if (funding.paymentSource === 'credits') {
        const quote = quoteByStage.get(meta.stage_id);
        if (!quote?.quote_id) throw new Error(`A fresh quote is unavailable for ${name}.`);
        fd.append('quote_id', quote.quote_id);
      }
    }
    return fd;
  };

  const makeSquare = async () => {
    setMakeError('');
    for (const kind of targetKinds) {
      const invalid = cfgs[kind].validate();
      if (invalid) {
        setMakeError(invalid);
        return;
      }
    }
    if (fundingBlocked) {
      setMakeError('Choose an available cloud payment source and wait for a valid quote.');
      return;
    }
    setMakeBusy(true);
    setWaiting(false);
    setOptionsOpen(false);
    if (open?.redo) setOpen({ ...open, redo: false });
    let full = false;
    try {
      for (const kind of targetKinds) {
        if (full) break;
        const funding = fundings[kind];
        const freshQuotes = funding.paymentSource === 'credits' && funding.cloudRequired ? await funding.quoteState.refresh() : [];
        const quoteByStage = new Map(freshQuotes.map((quote) => [quote.stage_id, quote]));
        // One request per file; a failed one does not stop the rest.
        for (const item of targets.filter((entry) => entry.kind === kind)) {
          const fd = processForm(kind, item.meta, quoteByStage, item.name);
          const started = { lastActionAt: Date.now(), convert: null, spatial: null, checked: false };
          try {
            const res = await api.form(`/api/${kind}/process`, fd);
            patch(item.id, { ...started, render: { jobId: res.job_id, status: 'working', startedAt: Date.now() } });
          } catch (submissionError) {
            if (submissionError?.code === 'QUEUE_FULL') {
              full = true;
              setWaiting(true);
              break;
            }
            setMakeError(billingErrorMessage(submissionError, 'Could not start cloud processing.'));
            patch(item.id, { ...started, checked: true, render: { jobId: null, status: 'failed', startedAt: Date.now() } });
          }
        }
        if (funding.cloudRequired) await refreshWallet();
      }
    } catch (requestError) {
      setMakeError(billingErrorMessage(requestError, 'Could not prepare cloud billing.'));
    } finally {
      setMakeBusy(false);
    }
  };

  useEffect(() => {
    if (waiting && !makeBusy && !makeMode && targets.length) makeSquare();
    // Runs when a job ends, with that render's targets and settings.
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Make 3D ──
  const startConvert = async () => {
    setConvertError('');
    setConvertBusy(true);
    try {
      const res = await api.post('/api/stereo/convert', { kind: cover.kind, ...spatialSource(cover) });
      patch(cover.id, { lastActionAt: Date.now(), convert: { jobId: res.job_id, status: 'working', startedAt: Date.now() } });
    } catch (requestError) {
      setConvertError(billingErrorMessage(requestError, 'Could not start MAKE 3D.'));
    } finally {
      setConvertBusy(false);
    }
  };

  // ── Depth version (spatial 3D) of the open post: only a 2D post gets one ──
  const posting = !!cover && !makeMode && !cover.posted && openItems.every((item) => postSource(item));
  const spatialShown = posting && !!features.spatial_default && openItems.every((item) => !stereoOf(item) && !item.convert);
  const spatialSlots = spatialShown && !spatialOff ? openItems : [];
  const spatialPending = spatialSlots.some((item) => !['done', 'failed'].includes(spatialOf(item)?.status));
  const spatialReady = spatialSlots.length > 0 && spatialSlots.every((item) => spatialOf(item)?.status === 'done');
  const spatialFailed = spatialSlots.filter((item) => spatialOf(item)?.status === 'failed');
  const spatialNext = spatialSlots.find((item) => !spatialOf(item));
  const spatialRunning = items.some((item) => item.spatial?.status === 'running');
  // One depth job at a time: the next slide starts when the last one ends.
  useEffect(() => {
    if (!spatialNext || spatialRunning || spatialStarting.current) return;
    spatialStarting.current = true;
    const source = spatialSource(spatialNext);
    const key = source.job_id || source.stage_id;
    api.post('/api/stereo/convert', { kind: spatialNext.kind, depth_pack: true, ...source }).then(
      (res) => {
        spatialStarting.current = false;
        patch(spatialNext.id, { spatial: { source: key, jobId: res.job_id, status: 'running' } });
      },
      (requestError) => {
        spatialStarting.current = false;
        patch(spatialNext.id, { spatial: { source: key, status: 'failed', error: billingErrorMessage(requestError, 'Could not start the depth version.') } });
      },
    );
  }, [spatialNext, spatialRunning, patch]);

  // ── Post ──
  const draft = group ? open.draft : cover?.draft;
  const setDraft = (next) => (group ? setOpen({ ...open, draft: next }) : patch(cover.id, { draft: next }));
  const converting = openItems.some((item) => item.convert?.status === 'working');
  const postDisabled = blocked.length > 0 || !posting || !draft?.title.trim() || publishing || converting || spatialPending;

  const post = async () => {
    setPostError('');
    setPublishing(true);
    try {
      const body = publishBody(openItems, draft, spatialReady ? spatialSlots.map((item) => spatialOf(item).jobId) : null);
      const res = await api.post('/api/uploads/publish', body);
      openItems.forEach((item) => patch(item.id, { posted: res, checked: false, lastActionAt: Date.now() }));
    } catch (e) {
      setPostError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const checkedReady = byShelf.ready.filter((item) => item.checked);
  const groupBlock = checkedReady.length < 2 ? '' : groupProblem(checkedReady);
  const postAsOne = () => {
    setPostError('');
    setOpen({ ids: checkedReady.map((item) => item.id), view: checkedReady[0].id, redo: false, draft: checkedReady[0].draft });
  };
  const reorder = (ids) => {
    if (ids.length < 2) {
      const only = items.find((item) => item.id === ids[0]);
      if (only) openItem(only);
      else setOpen(null);
      return;
    }
    setOpen({ ...open, ids, view: ids.includes(open.view) ? open.view : ids[0] });
  };
  const moveSlide = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= open.ids.length) return;
    const ids = open.ids.slice();
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder(ids);
  };

  // ── Options and the Make button ──
  const makeLabel = `${quoteStale ? 'Retry quote & ' : ''}${squareOnly ? (quoteStale ? 'upscale' : 'Upscale') : `${quoteStale ? 'make' : 'Make'} ${targets.length > 1 ? `${targets.length} ` : ''}square`}${totalCredits ? ` · ${totalCredits} credits` : ''}`;
  const makeButton = (
    <Button
      variant="primary"
      className="sx-studio-render"
      disabled={blocked.length > 0 || fundingBlocked || studioBlocked || makeBusy || !targets.length || nothingToDo}
      disabledReasons={[
        blocked.length && blocked[0].label + ' UNAVAILABLE — CHECK SYSTEM PROBES',
        !blocked.length && studioBlocked && 'STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI',
        !blocked.length && !studioBlocked && fundingBlocked && 'CHOOSE HOW TO PAY IN OPTIONS',
        !targets.length && 'TICK THE FILES TO MAKE SQUARE',
        nothingToDo && 'PICK A QUALITY TO UPSCALE, OR KEEP THE FILE AS IT IS',
      ]}
      loading={makeBusy}
      onClick={makeSquare}
    >
      <SquareIcon /> {makeLabel}
    </Button>
  );
  const makeErrorBox = makeError ? (
    <div className="sx-error-box" role="alert">
      <div className="sx-error-title">COULD NOT START</div>
      <div>{makeError}</div>
    </div>
  ) : null;
  const optionsFor = (kind) => (
    <>
      <OptionsPanel
        cfg={cfgs[kind]}
        funding={{ ...fundings[kind], setPaymentSource }}
        probes={probes}
        studioOk={studioOk}
        squareOnly={squareOnly}
        maxSourceDur={Math.max(0, ...targets.filter((item) => item.kind === 'video').map((item) => item.meta?.duration || 0)) || 60}
      />
      {makeButton}
      {makeErrorBox}
    </>
  );
  const shownKind = targetKinds.includes(optionsKind) ? optionsKind : targetKinds[0];

  const watch = (item, slot, job, extra) => (
    <JobWatcher
      key={job.jobId}
      jobId={job.jobId}
      kind={item.kind}
      onProgress={(state) => setProgress((all) => ({ ...all, [job.jobId]: state }))}
      {...extra}
      onSettled={(state) => {
        setSettled((count) => count + 1);
        if (slot === 'spatial') {
          patch(item.id, (current) => ({ spatial: { ...current.spatial, status: state?.status === 'complete' ? 'done' : 'failed' } }));
          return;
        }
        if (state?.status !== 'complete') patch(item.id, (current) => ({ [slot]: { ...current[slot], status: state?.status || 'failed' } }));
        refreshWallet({ silent: true });
        // The server now knows whether the result reached the cloud, and until when it is kept.
        reload();
      }}
    />
  );
  const onResult = (item, slot) => ({
    onDone: (result) => patch(item.id, (current) => ({ lastActionAt: Date.now(), [slot]: { ...current[slot], status: 'ready', result } })),
  });

  const tile = (item, extra) => (
    <MediaTile key={item.id} item={item} now={now} retention={retention} progress={progress[item.render?.jobId]} onOpen={openItem} {...extra} />
  );
  const check = (item, checked) => patch(item.id, { checked });
  const discardable = (item) => (!item.render && !item.posted ? (target) => remove(target.id) : undefined);

  return (
    <div
      className="sx-upload-media"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
    >
      <Hero title="UPLOAD" style={{ marginBottom: 4 }} />
      <div className="sx-media-bar">
        <Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Upload views" className="sx-media-tabs" />
        {tab === 'gallery' ? (
          <div className="sx-media-sort" role="group" aria-label="Sort">
            <IconButton label="Sort by time added" aria-pressed={sort === 'added'} onClick={() => setSort('added')}><ClockIcon /></IconButton>
            <IconButton label="Sort by last action" aria-pressed={sort === 'last_action'} onClick={() => setSort('last_action')}><ActivityIcon /></IconButton>
          </div>
        ) : null}
        <label className="sx-media-add sx-btn sx-primary" title="Add photos or videos">
          <IndustrialUploadIcon className="sx-media-icon" /> Add
          <input
            type="file"
            accept={ACCEPT}
            multiple
            aria-label="Add photos or videos"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              onFiles(files);
            }}
          />
        </label>
      </div>

      {blocked.length ? (
        <BlockingBanner title="ENVIRONMENT NOT READY" lines={blocked.map(probeLine)} />
      ) : null}
      {pickError ? (
        <div className="sx-error-box" role="alert">
          <div className="sx-error-title">FILES NOT ADDED</div>
          <div>{pickError}</div>
        </div>
      ) : null}
      {staging > 0 ? <p className="sx-media-staging" role="status" aria-busy="true">Adding {staging} file{staging > 1 ? 's' : ''}…</p> : null}

      {!items.length && !staging ? (
        <div className="sx-media-empty">
          <p className="sx-media-empty-line">Nothing here yet.</p>
          <UploadZone accept={ACCEPT} multiple onFiles={onFiles} caption="Photos and videos. Anything not square is made square before it is posted." />
        </div>
      ) : tab === 'gallery' ? (
        <ul className="sx-media-grid" aria-label="All media">{sortItems(items, sort).map((item) => tile(item))}</ul>
      ) : (
        <>
          {byShelf.needs.length ? (
            <section className="sx-media-shelf" aria-labelledby="shelf-needs">
              <header className="sx-media-shelf-head">
                <h2 id="shelf-needs">Needs square <span>{byShelf.needs.length}</span></h2>
                {makeMode ? null : makeButton}
                <IconButton label="Options" onClick={() => setOptionsOpen(true)} disabled={!targets.length}><SlidersIcon /></IconButton>
              </header>
              {makeMode || optionsOpen ? null : makeErrorBox}
              {waiting ? <p className="sx-media-staging" role="status">Waiting for a free slot. The checked files start when a running job ends.</p> : null}
              <ul className="sx-media-grid">
                {byShelf.needs.map((item) => tile(item, { price: item.checked ? priceOf(item) : null, onCheck: item.live ? check : undefined, onDiscard: discardable(item) }))}
              </ul>
            </section>
          ) : null}
          {byShelf.working.length + byShelf.ready.length ? (
            <section className="sx-media-shelf" aria-labelledby="shelf-ready">
              <header className="sx-media-shelf-head">
                <h2 id="shelf-ready">Ready to post <span>{byShelf.ready.length}</span></h2>
                {checkedReady.length > 1 ? (
                  <Button variant="primary" onClick={postAsOne} disabled={!!groupBlock} disabledReasons={[groupBlock]}>
                    <StackIcon /> Post {checkedReady.length} as one
                  </Button>
                ) : null}
              </header>
              <ul className="sx-media-grid">
                {byShelf.working.map((item) => tile(item))}
                {byShelf.ready.map((item) => tile(item, { onCheck: check, onDiscard: discardable(item) }))}
              </ul>
            </section>
          ) : null}
          {byShelf.posted.length ? (
            <details className="sx-media-shelf sx-media-posted">
              <summary>Posted <span>{byShelf.posted.length}</span></summary>
              <ul className="sx-media-grid">{byShelf.posted.map((item) => tile(item))}</ul>
            </details>
          ) : null}
        </>
      )}

      {items.map((item) => [
        item.render?.status === 'working' && item.render.jobId ? watch(item, 'render', item.render, onResult(item, 'render')) : null,
        item.convert?.status === 'working' ? watch(item, 'convert', item.convert, onResult(item, 'convert')) : null,
        item.spatial?.status === 'running' ? watch(item, 'spatial', item.spatial) : null,
      ])}

      {optionsOpen && !open && targets.length ? (
        <Dialog className="sx-modal-backdrop" aria-label="Options" onClose={() => setOptionsOpen(false)} busy={makeBusy}>
          <div className="sx-media-dialog sx-media-options-dialog">
            <header className="sx-media-dialog-head">
              <span className="sx-media-dialog-title">Options</span>
              <IconButton label="Close" data-dialog-close onClick={() => setOptionsOpen(false)}><CloseIcon /></IconButton>
            </header>
            <div className="sx-media-side">
              {targetKinds.length > 1 ? (
                <Segmented options={KIND_TABS} value={KIND_TABS[KINDS.indexOf(shownKind)]} onChange={(value) => setOptionsKind(KINDS[KIND_TABS.indexOf(value)])} ariaLabel="Options for" />
              ) : null}
              {optionsFor(shownKind)}
            </div>
          </div>
        </Dialog>
      ) : null}

      {cover ? (
        <MediaDialog
          items={openItems}
          view={open.view}
          onView={(view) => setOpen({ ...open, view })}
          onMove={moveSlide}
          onRemove={(index) => reorder(open.ids.filter((_, position) => position !== index))}
          onClose={() => setOpen(null)}
          onStep={!group && items.length > 1 ? step : undefined}
          makeMode={makeMode}
          options={makeMode ? optionsFor(cover.kind) : null}
          progress={progress}
          cfg={cfgs[cover.kind]}
          draft={draft}
          onDraft={setDraft}
          onStereo={(on) => patch(cover.id, { stereoOn: on })}
          onRedo={!group && cover.live && !cover.posted && shelfOf(cover) === 'ready' && !stereoOf(cover) && !converting ? () => setOpen({ ...open, redo: true }) : undefined}
          onRedoBack={open.redo && shelfOf(cover) === 'ready' ? () => setOpen({ ...open, redo: false }) : undefined}
          canConvert={!!features.stereo_convert && !group && !stereoOf(cover)}
          convertBusy={convertBusy || blocked.length > 0}
          convertError={convertError}
          onConvert={startConvert}
          onDropConvert={() => patch(cover.id, { convert: null })}
          spatial={{
            shown: spatialShown,
            on: !spatialOff,
            onToggle: (on) => setSpatialOff(!on),
            failed: spatialFailed.length > 0,
            errors: spatialFailed.map((item) => spatialOf(item).error).filter(Boolean),
          }}
          postDisabled={postDisabled}
          postReasons={[!draft?.title.trim() && 'A TITLE IS NEEDED TO POST']}
          publishing={publishing}
          postError={postError}
          onPost={post}
          user={user}
        />
      ) : null}
    </div>
  );
}
