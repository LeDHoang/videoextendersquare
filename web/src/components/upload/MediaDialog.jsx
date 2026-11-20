import { useNavigate } from 'react-router-dom';
import Dialog from '../ui/Dialog.jsx';
import IconButton from '../ui/IconButton.jsx';
import Progress from '../ui/Progress.jsx';
import { CancelJobButton } from '../ui/JobRunner.jsx';
import { Button, ToggleRow } from '../ui/controls.jsx';
import { STEREO_LABELS, stereoEyeSize, stereoFrame } from '../../utils/mediaFormat.js';
import { masterSize } from '../../utils/aspect.js';
import { matchesTarget } from '../../utils/cloudBilling.js';
import { CheckIcon, CloseIcon, CubeIcon, DownloadIcon, RedoIcon, SendIcon, SquareIcon, StackIcon } from '../icons/index.jsx';
import StudioStage from './StudioStage.jsx';
import PostForm from './PostForm.jsx';
import { metaStereoCandidate, postSource, shelfOf, spatialOf, stereoOf } from './mediaItems.js';
import { onRovingKeyDown } from '../ui/roving.js';

// A result made elsewhere has no upload here; its stage is the square master.
const [MASTER_SIDE] = masterSize(1, 1, '1:1');
const MASTER_META = { width: MASTER_SIDE, height: MASTER_SIDE, orientation: 'SQUARE' };
const even = (n) => n + (n % 2);

// Detection result + 3D switch for an upload in a stereo frame shape. A 9:8 /
// 8:9 frame is never detected: the person turns 3D on and picks SBS or TB.
function StereoChoice({ item, onChange }) {
  const frame = stereoFrame(item.meta?.width, item.meta?.height);
  const manual = !metaStereoCandidate(item.meta) && !!frame?.manual;
  const candidate = item.stereoPick || metaStereoCandidate(item.meta) || frame?.layout;
  const label = STEREO_LABELS[candidate];
  const on = !!stereoOf(item);
  const onToggle = (next) => onChange({ stereoOn: next, ...(next && manual && !item.stereoPick ? { stereoPick: candidate } : {}) });
  const eye = stereoEyeSize(candidate, item.meta?.width, item.meta?.height);
  const method = item.meta?.stereo?.method;
  const how = method === 'metadata'
    ? 'Detected from the file\'s stereo metadata.'
    : method === 'content'
      ? 'Detected: the two halves show the same scene from two eyes.'
      : method === 'no_parallax'
        ? 'The two halves are the same picture with no depth offset (a split-screen copy), so 3D is off.'
        : null;
  return (
    <div className="sx-studio-stereo">
      <div className={`sx-accent-block ${on ? '' : 'sx-muted'}`} role="note">
        <div className="sx-accent-block-title">
          {item.meta?.stereo?.detected ? `3D ${label} DETECTED` : `${frame?.shape || (candidate === 'sbs' ? '2:1' : '1:2')} FRAME — IS THIS 3D ${manual ? '' : `${label}?`}`.trim()}
        </div>
        <div className="sx-accent-block-body">
          <p>
            {on
              ? `Posted as it is, in 3D: each eye gets one ${eye.width}×${eye.height} picture in VR, and 2D views show the left eye.`
              : manual
                ? 'Turn on if this file holds a left/right eye pair, then say how the eyes sit. Off posts it as one flat picture.'
                : `Turn on if this file holds a left/right eye pair ${candidate === 'sbs' ? 'side by side' : 'stacked top over bottom'}. Off posts it as one flat picture.`}
          </p>
          {how ? <p className="sx-monospace-sm">{how}</p> : null}
        </div>
      </div>
      <ToggleRow label={manual ? 'STEREOSCOPIC 3D' : `STEREOSCOPIC 3D · ${label}`} checked={on} onChange={onToggle} help="One picture per eye; nothing is filled" />
      {manual && on ? (
        <div className="sx-seg" role="radiogroup" aria-label="Eye layout" onKeyDown={onRovingKeyDown}>
          {['sbs', 'tb'].map((layout) => (
            <button
              type="button"
              key={layout}
              role="radio"
              aria-checked={candidate === layout}
              tabIndex={candidate === layout ? 0 : -1}
              className={candidate === layout ? 'sx-selected' : ''}
              onClick={() => onChange({ stereoPick: layout })}
            >
              {STEREO_LABELS[layout]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ErrorBox({ title, children }) {
  return (
    <div className="sx-error-box" role="alert">
      <div className="sx-error-title">{title}</div>
      <div>{children}</div>
    </div>
  );
}

// One file (or the images of one post) opened from a tile: the stage on the
// left; on the right, what the file needs next: make it, wait, or post.
export default function MediaDialog({
  items,           // the open items, in post order
  view,            // key of the slide on the stage (several images)
  onView,
  onMove,
  onRemove,
  onClose,
  onStep,          // (-1 | 1) to the neighbouring file, or undefined
  makeMode,        // the options are showing (the file needs making, or is being redone)
  options,         // the options panel and its Make button
  progress,        // { [jobId]: job state }
  cfg,
  draft,
  onDraft,
  onStereo,
  onRedo,          // open the options for a file that is already postable, or undefined
  onRedoBack,
  canConvert,
  convertBusy,
  convertError,
  onConvert,
  onDropConvert,
  spatial,         // { shown, on, onToggle, failed, errors, pending } or null
  postDisabled,
  postReasons,
  publishing,
  postError,
  onPost,
  user,
}) {
  const navigate = useNavigate();
  const cover = items[0];
  const group = items.length > 1;
  const meta = cover.meta || MASTER_META;
  const shelf = shelfOf(cover, cfg.asIsShapeFor(meta));
  const stereo = stereoOf(cover);
  const working = !group && shelf === 'working';
  const render = cover.render;
  const convert = cover.convert;
  const result = convert?.status === 'ready' ? convert.result : render?.status === 'ready' ? render.result : null;
  const entryOf = (item) => {
    const made = item.render?.status === 'ready' ? item.render.result : null;
    return {
      key: item.id,
      name: item.name,
      kind: item.kind,
      meta: item.meta || MASTER_META,
      sourceKnown: !!item.meta,
      url: group && made ? made.preview_url || made.download_url : item.url || item.thumb,
      result: group ? null : result,
    };
  };
  const posted = cover.posted;
  const stereoChoice = !group && !posted && cover.live && !render
    && (metaStereoCandidate(cover.meta) || stereoFrame(cover.meta?.width, cover.meta?.height)?.manual);
  const title = group ? `${items.length} images, one post` : cover.name;
  // An upload that already has its shape can be posted as it is or upscaled first.
  const asIsChoice = !group && !posted && !render && !stereo && !!cover.meta && !!postSource(cover, cfg.asIsShapeFor(meta)) && (onRedo || onRedoBack);
  // The shape the stage shows: the one being made, else the file's own.
  const making = makeMode || working || !!render;
  const target = making ? cfg.shapeFor(meta) : null;
  // The size the file will come out at with the current options.
  const [masterWidth, masterHeight] = masterSize(meta.width, meta.height, target);
  const targetLabel = !(makeMode || working)
    ? null
    : !cfg.noUpscale
      ? `${masterWidth}×${masterHeight}`
      : cover.meta && matchesTarget(cover.meta, target) ? `${even(cover.meta.width)}×${even(cover.meta.height)}` : null;

  return (
    <Dialog className="sx-modal-backdrop" aria-label={title} onClose={onClose} busy={publishing}>
      <div className="sx-media-dialog">
        <header className="sx-media-dialog-head">
          <span className="sx-media-dialog-title" title={title}>{title}</span>
          {onStep ? (
            <>
              <IconButton label="Previous file" onClick={() => onStep(-1)}>‹</IconButton>
              <IconButton label="Next file" onClick={() => onStep(1)}>›</IconButton>
            </>
          ) : null}
          <IconButton label="Close" data-dialog-close onClick={onClose}><CloseIcon /></IconButton>
        </header>
        <div className="sx-media-dialog-body">
          <StudioStage
            layout={group ? 'slideshow' : 'single'}
            entries={items.map(entryOf)}
            selectedKey={group ? view : cover.id}
            onSelect={onView}
            staging={false}
            pickError=""
            extendPath={makeMode || !!render}
            stereo={stereo}
            upscaleOnly={cfg.upscaleOnly}
            targetLabel={targetLabel}
            target={target}
            outpaintActive={!cfg.upscaleOnly}
            trim={cover.kind === 'video' ? { enabled: cfg.trimEnabled, start: cfg.trimStart, dur: cfg.trimDur } : null}
            onMoveGalleryItem={onMove}
            onRemoveGalleryItem={onRemove}
            locked
          />
          <div className="sx-media-side">
            {stereoChoice ? <StereoChoice item={cover} onChange={onStereo} /> : null}
            {asIsChoice ? (
              <div className="sx-media-choices" role="radiogroup" aria-label="Ready file" onKeyDown={onRovingKeyDown}>
                {[
                  ['Keep as is', 'Post the file at its own resolution', CheckIcon, !makeMode, onRedoBack],
                  ['Upscale', 'Upscale it to 2K before posting', StackIcon, makeMode, onRedo],
                ].map(([name, hint, Icon, picked, pick]) => (
                  <button
                    type="button"
                    key={name}
                    role="radio"
                    aria-checked={picked}
                    tabIndex={picked ? 0 : -1}
                    className={`sx-media-choice ${picked ? 'sx-selected' : ''}`}
                    title={hint}
                    onClick={picked ? undefined : pick}
                  >
                    <Icon />
                    <span className="sx-media-choice-name">{name}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {posted ? (
              <>
                <div className="sx-accent-block" role="status">
                  <div className="sx-accent-block-title">✓ POSTED</div>
                  <div className="sx-accent-block-body"><p>{posted.meta?.title || draft.title}</p></div>
                </div>
                <div className="sx-studio-actions">
                  {posted.rel_path ? (
                    <Button variant="primary" onClick={() => navigate(posted.post_id
                      ? `/reels?post=${encodeURIComponent(posted.post_id)}&codec=all`
                      : `/reels?folder=uploads&codec=all&sort=newest&play=${encodeURIComponent(posted.rel_path)}`)}>
                      ▶ PLAY IN REELS
                    </Button>
                  ) : null}
                  <Button onClick={() => navigate('/explore')}>EXPLORE</Button>
                  <Button onClick={() => navigate('/profile/' + (posted.meta?.creator?.username || user.username))}>PROFILE</Button>
                </div>
              </>
            ) : makeMode ? (
              <>
                {onRedoBack && !asIsChoice ? <Button onClick={onRedoBack}>‹ BACK TO POST</Button> : null}
                {options}
              </>
            ) : working ? (
              <div className="sx-media-working">
                {progress[render.jobId] ? <Progress job={progress[render.jobId]} name={cover.name} /> : <p role="status" className="sx-studio-note">Starting…</p>}
                <CancelJobButton jobId={render.jobId} kind={cover.kind} />
              </div>
            ) : (
              <>
                {!group ? (
                  <div className="sx-media-actions" role="group" aria-label="File actions">
                    {result ? (
                      <IconButton as="a" href={result.download_url} download label={convert?.status === 'ready' ? 'Download the 3D file' : 'Download the 2K file'}>
                        <DownloadIcon />
                      </IconButton>
                    ) : null}
                    {onRedo && !asIsChoice ? <IconButton label="Make again" onClick={onRedo}><RedoIcon /></IconButton> : null}
                    {canConvert && !convert ? (
                      <IconButton label="Make 3D" title="Make 3D: a side-by-side pair for VR. No credits. Videos up to 60 s." onClick={onConvert} disabled={convertBusy}>
                        <CubeIcon />
                      </IconButton>
                    ) : null}
                    {convert?.status === 'ready' ? (
                      <IconButton label="Remove 3D" title="Remove 3D and post the flat file" onClick={onDropConvert}><SquareIcon /></IconButton>
                    ) : null}
                  </div>
                ) : null}
                {convert?.status === 'working' ? (
                  <div className="sx-media-working">
                    {progress[convert.jobId] ? <Progress job={progress[convert.jobId]} name="Making 3D" /> : <p role="status" className="sx-studio-note">Making 3D…</p>}
                  </div>
                ) : null}
                {convertError ? <ErrorBox title="MAKE 3D FAILED">{convertError}</ErrorBox> : null}
                {convert?.status === 'failed' ? <ErrorBox title="MAKE 3D FAILED">The 3D version could not be made. The flat version is posted.</ErrorBox> : null}

                {spatial?.shown ? (
                  <div className="sx-media-spatial">
                    <ToggleRow label="Add depth for VR" checked={spatial.on} onChange={spatial.onToggle} help="A depth version for VR headsets, posted beside the 2D file. No credits. Videos up to 60 s." />
                    {spatial.on ? items.map((item) => {
                      const job = spatialOf(item);
                      const state = job?.jobId ? progress[job.jobId] : null;
                      return job?.status === 'running' ? (
                        <p key={item.id} role="status" className="sx-studio-note">
                          Making the depth version{group ? ` of ${item.name}` : ''}… {state ? `${Math.round((state.progress || 0) * 100)}%` : ''}
                        </p>
                      ) : null;
                    }) : null}
                    {spatial.failed ? (
                      <ErrorBox title="DEPTH VERSION FAILED — THE POST IS 2D ONLY">
                        {spatial.errors.map((error) => <div key={error}>{error}</div>)}
                      </ErrorBox>
                    ) : null}
                  </div>
                ) : null}

                <PostForm draft={draft} onChange={onDraft} />
                <Button variant="primary" className="sx-studio-render" disabled={postDisabled} disabledReasons={postReasons} loading={publishing} onClick={onPost}>
                  <SendIcon /> POST
                </Button>
                {postError ? <ErrorBox title="POST FAILED">{postError}</ErrorBox> : null}
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
