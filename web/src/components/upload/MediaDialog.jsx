import { useNavigate } from 'react-router-dom';
import Dialog from '../ui/Dialog.jsx';
import IconButton from '../ui/IconButton.jsx';
import Progress from '../ui/Progress.jsx';
import { CancelJobButton } from '../ui/JobRunner.jsx';
import { Button, ToggleRow } from '../ui/controls.jsx';
import { STEREO_LABELS, stereoEyeSize } from '../../utils/mediaFormat.js';
import { CloseIcon, CubeIcon, DownloadIcon, RedoIcon, SendIcon, SquareIcon } from '../icons/index.jsx';
import StudioStage from './StudioStage.jsx';
import PostForm from './PostForm.jsx';
import { metaStereoCandidate, shelfOf, spatialOf, stereoOf } from './mediaItems.js';

// A result made elsewhere has no upload here; its stage is the square master.
const MASTER_META = { width: 3840, height: 3840, orientation: 'SQUARE' };

// Detection result + 3D switch for an exact 2:1 / 1:2 upload.
function StereoChoice({ item, onToggle }) {
  const candidate = metaStereoCandidate(item.meta);
  const label = STEREO_LABELS[candidate];
  const on = !!stereoOf(item);
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
          {item.meta?.stereo?.detected ? `3D ${label} DETECTED` : `${candidate === 'sbs' ? '2:1' : '1:2'} FRAME — IS THIS 3D ${label}?`}
        </div>
        <div className="sx-accent-block-body">
          <p>
            {on
              ? `Posted as it is, in 3D: each eye gets one ${eye.width}×${eye.height} square in VR, and 2D views show the left eye.`
              : `Turn on if this file holds a left/right eye pair ${candidate === 'sbs' ? 'side by side' : 'stacked top over bottom'}. Off makes it a flat square instead.`}
          </p>
          {how ? <p className="sx-monospace-sm">{how}</p> : null}
        </div>
      </div>
      <ToggleRow label={`STEREOSCOPIC 3D · ${label}`} checked={on} onChange={onToggle} help="One square per eye; it is not made square" />
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

// One file (or the images of one post) opened from a tile: the square stage on
// the left; on the right, what the file needs next: make it square, wait, or post.
export default function MediaDialog({
  items,           // the open items, in post order
  view,            // key of the slide on the stage (several images)
  onView,
  onMove,
  onRemove,
  onClose,
  onStep,          // (-1 | 1) to the neighbouring file, or undefined
  makeMode,        // the options are showing (the file needs square, or is being redone)
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
  const shelf = shelfOf(cover);
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
      url: group && made ? made.preview_url || made.download_url : item.url || item.thumb,
      result: group ? null : result,
    };
  };
  const posted = cover.posted;
  const stereoChoice = !group && !posted && cover.live && !render && metaStereoCandidate(cover.meta);
  const title = group ? `${items.length} images, one post` : cover.name;

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
            outpaintActive={!cfg.upscaleOnly}
            trim={cover.kind === 'video' ? { enabled: cfg.trimEnabled, start: cfg.trimStart, dur: cfg.trimDur } : null}
            onMoveGalleryItem={onMove}
            onRemoveGalleryItem={onRemove}
            locked
          />
          <div className="sx-media-side">
            {stereoChoice ? <StereoChoice item={cover} onToggle={onStereo} /> : null}

            {posted ? (
              <>
                <div className="sx-accent-block" role="status">
                  <div className="sx-accent-block-title">✓ POSTED</div>
                  <div className="sx-accent-block-body"><p>{posted.meta?.title || draft.title}</p></div>
                </div>
                <div className="sx-studio-actions">
                  {posted.rel_path ? (
                    <Button variant="primary" onClick={() => navigate(`/reels?folder=uploads&codec=all&sort=newest&play=${encodeURIComponent(posted.rel_path)}`)}>
                      ▶ PLAY IN REELS
                    </Button>
                  ) : null}
                  <Button onClick={() => navigate('/explore')}>EXPLORE</Button>
                  <Button onClick={() => navigate('/profile/' + (posted.meta?.creator?.username || user.username))}>PROFILE</Button>
                </div>
              </>
            ) : makeMode ? (
              <>
                {onRedoBack ? <Button onClick={onRedoBack}>‹ BACK TO POST</Button> : null}
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
                      <IconButton as="a" href={result.download_url} download label={convert?.status === 'ready' ? 'Download the 3D file' : 'Download the 4K square'}>
                        <DownloadIcon />
                      </IconButton>
                    ) : null}
                    {onRedo ? <IconButton label="Make square again" onClick={onRedo}><RedoIcon /></IconButton> : null}
                    {canConvert && !convert ? (
                      <IconButton label="Make 3D" title="Make 3D: a side-by-side pair for VR. No credits. Videos up to 60 s." onClick={onConvert} disabled={convertBusy}>
                        <CubeIcon />
                      </IconButton>
                    ) : null}
                    {convert?.status === 'ready' ? (
                      <IconButton label="Remove 3D" title="Remove 3D and post the flat square" onClick={onDropConvert}><SquareIcon /></IconButton>
                    ) : null}
                  </div>
                ) : null}
                {convert?.status === 'working' ? (
                  <div className="sx-media-working">
                    {progress[convert.jobId] ? <Progress job={progress[convert.jobId]} name="Making 3D" /> : <p role="status" className="sx-studio-note">Making 3D…</p>}
                  </div>
                ) : null}
                {convertError ? <ErrorBox title="MAKE 3D FAILED">{convertError}</ErrorBox> : null}
                {convert?.status === 'failed' ? <ErrorBox title="MAKE 3D FAILED">The 3D version could not be made. The flat square is posted.</ErrorBox> : null}

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
