import { Link } from 'react-router-dom';
import { LEGAL, Section, V } from '../components/legal/LegalKit.jsx';

/*
 * Privacy Policy. Every data category, provider, cookie, and retention period below was checked
 * against the code (server/social/models.py, server/social/auth.py, server/routers/*, pipeline/*,
 * web/src storage keys). Update this page in the same change when any of those change.
 */
export default function PrivacyPage() {
  return (
    <article className="sx-legal">
      <header className="sx-ps-head">
        <div>
          <h1 className="sx-ps-title">PRIVACY POLICY</h1>
          <div className="sx-ps-kicker">EFFECTIVE <V k="effectiveDate" /></div>
        </div>
      </header>

      <Section id="privacy-who" title="1. Who we are">
        <p>
          ECHO is operated by <V k="company" />, <V k="address" /> (“ECHO”, “we”, “us”). We are responsible
          for the personal data described in this policy. For privacy questions or requests, email{' '}
          <V k="privacyEmail" />. This policy is part of our <Link to="/terms">Terms of Service</Link>.
        </p>
      </Section>

      <Section id="privacy-collect" title="2. Data we collect">
        <p>We collect only what the Service needs to work:</p>
        <ul>
          <li>
            <strong>Account data:</strong> email address, username, password (stored only as a one-way hash),
            display name, and, if you add them, bio, website, and avatar image. We record when you created the
            account, when you were last active, and which version of the Terms you accepted and when.
          </li>
          <li>
            <strong>Content:</strong> photos and videos you upload, the processed versions we make, captions,
            tags, location tags you add, comments, likes, saves, follows, blocks, and Reel Packs.
          </li>
          <li>
            <strong>Messages:</strong> direct messages and their attachments, GIFs, and shared posts.
          </li>
          <li>
            <strong>Viewing activity:</strong> which reels and Reel Packs you view, how long they play and are
            on screen, playback position and quality, and where in the app you watched them. We use this for
            recommendations, view counts, and reel rewards. If you are not signed in, we link this activity to
            a random anonymous ID stored in a cookie, not to your identity.
          </li>
          <li>
            <strong>Purchases and credits:</strong> the credit pack you bought, amounts, payment status, refunds,
            and your credit balance history. Stripe collects your card details; we never receive or store them.
          </li>
          <li>
            <strong>Personal fal.ai key:</strong> if you save one, we store it encrypted, and keep a short hint
            (its last characters) so you can recognise it.
          </li>
          <li>
            <strong>Security data:</strong> for each signed-in session, your browser’s user-agent and a keyed
            hash of your IP address (not the IP address itself). We also keep hashed keys of recent requests to
            enforce rate limits and to stop reward abuse.
          </li>
          <li>
            <strong>Reports:</strong> what you report and why, and moderator decisions.
          </li>
        </ul>
        <p>
          <strong>Photo and video metadata:</strong> files you upload can contain hidden metadata, such as the
          camera model, the date, and GPS location. At present, the original file of a published post is shared
          as you uploaded it, so this metadata can be visible to people who download it. Remove location data
          from a file before you upload it if you do not want to share it.
        </p>
        <p>
          <strong>VR:</strong> the VR experience uses your headset and hand position only on your device to
          draw the scene. We do not send or store this data.
        </p>
      </Section>

      <Section id="privacy-use" title="3. How we use your data">
        <ul>
          <li><strong>To provide the Service</strong> (performing our contract with you): accounts, posting, feeds, messages, processing jobs, credits, and support.</li>
          <li><strong>To recommend reels</strong> (our legitimate interest in a relevant feed): we use your viewing activity, likes, and follows to choose what to show you. We do not use it for advertising.</li>
          <li><strong>To keep ECHO safe</strong> (legitimate interest, and legal obligation where the law requires): rate limits, fraud and reward-abuse checks, moderation, and handling reports.</li>
          <li><strong>To process payments and keep financial records</strong> (contract and legal obligation).</li>
          <li><strong>To send service emails</strong> (contract), such as password reset links. We do not send marketing email.</li>
        </ul>
        <p>We do not sell your personal data, we do not show third-party ads, and we do not use third-party analytics or tracking tools.</p>
      </Section>

      <Section id="privacy-share" title="4. Who receives your data">
        <ul>
          <li><strong>Other users:</strong> your public profile, public posts (including location tags), comments, and Reel Packs you share. Messages go only to the people in the conversation.</li>
          <li><strong>fal.ai and the AI models it hosts</strong> (for example Luma Ray): when you choose cloud processing, the photos or videos you upload and your job settings are sent to fal.ai so it can produce the result. The media is uploaded to fal.ai’s storage for the job. Local processing does not send your media to fal.ai.</li>
          <li><strong>Stripe:</strong> checkout and payments. Stripe receives your payment details directly, plus your ECHO account ID and the pack you chose.</li>
          <li><strong>Tenor (Google):</strong> GIF search terms, which our server sends for you. GIF images then load directly from Tenor’s servers, so Tenor receives your IP address and browser details when you search for or view a GIF.</li>
          <li><strong>OpenStreetMap:</strong> map tile requests. Our server fetches and caches the tiles, so OpenStreetMap does not receive your IP address from us.</li>
          <li><strong>Our email provider:</strong> your email address and the content of service emails.</li>
          <li><strong>Cloudflare:</strong> Cloudflare Tunnel carries all traffic between your browser and our server, Cloudflare’s CDN caches and delivers media, and Cloudflare R2 stores published photos and videos. Cloudflare therefore receives your IP address and the requests you make.</li>
          <li><strong>Hetzner:</strong> hosts the server that runs ECHO, including our database and the files you upload.</li>
          <li><strong>Sentry:</strong> receives error reports from our server when something goes wrong, which can include technical details of the request that failed. Sentry is not used in the web app or the VR player.</li>
          <li><strong>Authorities:</strong> when the law requires it, or to protect people from serious harm, for example reports of child sexual abuse material.</li>
          <li><strong>A buyer or successor</strong> if ECHO is sold or merged. We will tell you before your data is covered by a different policy.</li>
        </ul>
      </Section>

      <Section id="privacy-cookies" title="5. Cookies and browser storage">
        <p>We use only cookies that the Service needs. We do not use advertising or analytics cookies.</p>
        <ul>
          <li><strong>Session cookie:</strong> keeps you signed in. It lasts up to 30 days, and you cannot read it with scripts.</li>
          <li><strong>Security (CSRF) cookie:</strong> protects your actions from forged requests. It lasts as long as your session.</li>
          <li><strong>Anonymous viewer cookie:</strong> a random ID that links viewing activity when you are not signed in, so view counts and recommendations work. It lasts 1 year.</li>
          <li><strong>Browser storage:</strong> your browser keeps your display preferences (such as grid density and view mode), message drafts, and an action you started before signing in. These stay on your device.</li>
        </ul>
      </Section>

      <Section id="privacy-retention" title="6. How long we keep data">
        <ul>
          <li><strong>Account and content:</strong> while your account exists. See section 7 for what happens when you delete it.</li>
          <li><strong>Signed-in sessions:</strong> up to 30 days, or until you sign out.</li>
          <li><strong>Rate-limit keys:</strong> 2 days.</li>
          <li><strong>Viewing activity and recommendation data:</strong> <V k="analyticsRetention" />.</li>
          <li><strong>Purchase and credit records:</strong> as long as tax and accounting law requires, also after account deletion.</li>
          <li><strong>Reports and moderation records:</strong> as long as needed to handle the report, appeals, and repeat abuse.</li>
          <li><strong>Backups:</strong> deleted on their normal schedule.</li>
        </ul>
      </Section>

      <Section id="privacy-delete" title="7. Deleting your account">
        <p>You can delete your account at any time in Profile settings. When you do:</p>
        <ul>
          <li>We remove your email, password, profile text, and avatar. Your username is replaced with a random placeholder.</li>
          <li>Your posts, Reel Packs, and comments are removed from the Service right away. The stored media files are deleted within <V k="mediaPurge" />.</li>
          <li>We delete your follows, likes, saves, blocks, password reset links, and saved fal.ai key, and we sign you out everywhere.</li>
          <li>Viewing activity and reports you made are kept without your account linked to them.</li>
          <li>Messages you sent are hidden from the people you talked with. We keep them for moderation and safety.</li>
          <li>We keep purchase and credit records, because the law requires us to keep financial records.</li>
        </ul>
      </Section>

      <Section id="privacy-security" title="8. Security">
        <p>
          We hash passwords, store only hashed IP addresses, and encrypt direct messages, report evidence, and
          saved fal.ai keys in our database. Messages are encrypted by our server, not end-to-end, so authorised
          ECHO staff can access a message when it is reported or when the law requires it. No system is fully
          secure. If a breach puts your data at risk, we will tell you and the authorities as the law requires.
        </p>
      </Section>

      <Section id="privacy-rights" title="9. Your rights">
        <p>Depending on where you live, you can ask us to:</p>
        <ul>
          <li>give you a copy of your personal data, including in a portable format;</li>
          <li>correct data that is wrong (you can edit most profile data yourself in Profile settings);</li>
          <li>delete your data (you can also delete your account yourself);</li>
          <li>limit or object to how we use it, for example for recommendations.</li>
        </ul>
        <p>
          Email <V k="privacyEmail" /> from the address on your account. We reply within 30 days. We may ask
          you to confirm your identity. You can also complain to the data protection authority where you live.
        </p>
      </Section>

      <Section id="privacy-children" title="10. Children">
        <p>
          ECHO is not for children under {LEGAL.minimumAge}. We do not knowingly collect data from them. If you
          believe a child under {LEGAL.minimumAge} has an account, tell us at <V k="privacyEmail" /> and we will
          delete it.
        </p>
      </Section>

      <Section id="privacy-transfers" title="11. International transfers">
        <p>
          We store data in <V k="hostingRegion" />. Some providers listed in section 4, such as fal.ai, Cloudflare,
          Sentry, Stripe, and Google, process data in other countries, including the United States. Where the law requires it,
          we use contracts or other approved safeguards for these transfers.
        </p>
      </Section>

      <Section id="privacy-changes" title="12. Changes to this policy">
        <p>
          We may update this policy. For important changes, we will tell you in the Service or by email before
          they take effect. The date at the top shows the current version.
        </p>
      </Section>

      <Section id="privacy-contact" title="13. Contact">
        <p>
          <V k="company" />, <V k="address" />. Privacy: <V k="privacyEmail" />. Other questions: <V k="contactEmail" />.
        </p>
        <p><Link to="/reels">Back to ECHO</Link></p>
      </Section>
    </article>
  );
}
