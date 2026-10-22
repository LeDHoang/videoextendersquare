// What a report points at, shown the way users see it, with a link to the live page.

function LiveLink({ href, children = 'VIEW LIVE ↗' }) {
  return href ? <a className="sx-report-live" href={href} target="_blank" rel="noreferrer">{children}</a> : null;
}

function Media({ target, small = false }) {
  const className = 'sx-report-media' + (small ? ' sx-report-media-small' : '');
  if (target.removed) return <div className={className + ' sx-report-media-gone'}>{small ? 'REMOVED' : 'REMOVED · MEDIA UNPUBLISHED'}</div>;
  if (!target.preview_url && !target.poster_url) return <div className={className + ' sx-report-media-gone'}>NO PREVIEW</div>;
  if (small || target.media_type === 'image') {
    return <a className={className} href={target.link} target="_blank" rel="noreferrer"><img src={target.poster_url || target.preview_url} alt="" loading="lazy" /></a>;
  }
  // preload="none": a long queue must not download every clip.
  return <video className={className} src={target.preview_url} poster={target.poster_url || undefined} controls muted playsInline preload="none" />;
}

export default function ReportTarget({ report }) {
  const { target_type: type } = report;
  const target = report.target || {};
  if (!Object.keys(target).length) {
    return <div className="sx-report-target sx-report-target-gone">THE REPORTED {type.toUpperCase()} NO LONGER EXISTS</div>;
  }
  if (type === 'post') {
    return (
      <div className="sx-report-target">
        <Media target={target} />
        <div className="sx-report-target-text">
          <strong>{target.title || 'Untitled post'}</strong>
          {target.caption ? <p>{target.caption}</p> : null}
          <span>BY @{target.owner || 'deleted'}{target.removed ? ' · REMOVED' : ''}</span>
          {target.removed ? null : <LiveLink href={target.link} />}
        </div>
      </div>
    );
  }
  if (type === 'comment') {
    return (
      <div className="sx-report-target">
        <blockquote className={'sx-report-quote' + (target.removed ? ' sx-report-removed' : '')}>
          <span>@{target.author || 'deleted'} COMMENTED{target.removed ? ' · REMOVED' : ''}</span>
          <p>{target.text}</p>
        </blockquote>
        {target.post ? (
          <div className="sx-report-parent">
            <Media target={target.post} small />
            <div className="sx-report-target-text">
              <span>ON POST</span>
              <strong>{target.post.title || 'Untitled post'}</strong>
              {target.post.removed ? null : <LiveLink href={target.link}>OPEN POST ↗</LiveLink>}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  if (type === 'pack') {
    return (
      <div className="sx-report-target">
        <div className="sx-report-target-text">
          <strong>{target.title || 'Untitled pack'}</strong>
          <span>REEL PACK · {(target.removed ? 'removed' : target.status || '').toUpperCase()}{target.visibility ? ' · ' + target.visibility.toUpperCase() : ''}</span>
          {target.removed ? null : <LiveLink href={target.link}>OPEN PACK ↗</LiveLink>}
        </div>
      </div>
    );
  }
  if (type === 'user') {
    return (
      <div className="sx-report-target">
        <div className="sx-report-target-text">
          <strong>@{target.username}</strong>
          <span>{target.display_name}{target.status && target.status !== 'active' ? ' · ' + target.status.toUpperCase() : ''}</span>
          {target.status === 'active' ? <LiveLink href={target.link}>OPEN PROFILE ↗</LiveLink> : null}
        </div>
      </div>
    );
  }
  // Direct message: the evidence copy taken when the report was filed.
  return (
    <div className="sx-report-target">
      {target.unavailable ? (
        <div className="sx-report-target-gone">{target.reason || 'The message evidence is unavailable.'}</div>
      ) : (
        <blockquote className="sx-report-quote">
          <span>PRIVATE MESSAGE · COPY TAKEN WHEN REPORTED</span>
          <p>{target.content?.text || '(' + (target.kind || 'non-text') + ' message)'}</p>
        </blockquote>
      )}
    </div>
  );
}
