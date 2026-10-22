import { Link } from 'react-router-dom';
import { LEGAL, Section, V } from '../components/legal/LegalKit.jsx';

/*
 * Terms of Service. Facts below (credit packs, reservation/release, reward limits, BYOK, deletion
 * behaviour) mirror RUNNING.md and server/billing; keep them in sync when those change.
 * Shared legal values (company, contacts, law) live in components/legal/LegalKit.jsx.
 */
export default function TermsPage() {
  return (
    <article className="sx-legal">
      <header className="sx-ps-head">
        <div>
          <h1 className="sx-ps-title">TERMS OF SERVICE</h1>
          <div className="sx-ps-kicker">EFFECTIVE <V k="effectiveDate" /></div>
        </div>
      </header>

      <Section id="terms-agreement" title="1. Agreement">
        <p>
          These Terms govern your use of ECHO, including the website, the reels feed, Reel Packs, messaging,
          the image and video processing tools, ECHO Credits, and the WebXR/VR experience (together, the
          “Service”). The Service is operated by <V k="company" />, <V k="address" /> (“ECHO”, “we”, “us”).
        </p>
        <p>By creating an account or using the Service, you agree to these Terms. If you do not agree, do not use the Service.</p>
      </Section>

      <Section id="terms-eligibility" title="2. Who can use ECHO">
        <ul>
          <li>
            You must be at least {LEGAL.minimumAge} years old, or older if the law in your country sets a higher
            minimum age for using online services without parental consent.
          </li>
          <li>
            If you are under 18 (or the age of majority where you live), a parent or legal guardian must agree
            to these Terms for you and must approve any purchase of ECHO Credits.
          </li>
          <li>You may not use the Service if we have previously banned you, or if the law forbids you from using it.</li>
        </ul>
      </Section>

      <Section id="terms-beta" title="3. Beta service">
        <p>
          ECHO is in beta. Registration may be by invitation only. Features may change, be limited, or be
          removed, and processing jobs may fail or take longer than estimated. We do not guarantee that the
          Service will be available without interruption.
        </p>
      </Section>

      <Section id="terms-accounts" title="4. Your account">
        <ul>
          <li>Give accurate information when you register, and keep your password secure.</li>
          <li>You are responsible for activity on your account. Tell us at <V k="contactEmail" /> if you think it has been accessed without your permission.</li>
          <li>Do not sell, share, or transfer your account, and do not create accounts to avoid a suspension or ban.</li>
          <li>Your username, display name, avatar, and profile text are public.</li>
        </ul>
      </Section>

      <Section id="terms-content" title="5. Your content">
        <p>
          You keep ownership of the photos, videos, captions, comments, Reel Packs, and messages you submit
          (“your content”). You confirm that you own your content or have every permission needed to post it,
          including for music, footage, and the people who appear in it.
        </p>
        <p>
          You give ECHO a worldwide, non-exclusive, royalty-free licence to host, store, copy, transcode,
          resize, and create technical versions of your content (for example previews, upscaled, outpainted,
          stereo 3D, and VR renditions), and to display and distribute it inside the Service according to the
          visibility you choose. We use this licence only to operate, secure, and improve the Service.
        </p>
        <ul>
          <li><strong>Public posts</strong> can be seen by anyone, including people who are not signed in, and can appear in feeds, search, tag, location, and Earth-map views.</li>
          <li><strong>Unlisted Reel Packs</strong> can be opened by anyone who has the link.</li>
          <li><strong>Location tags</strong> you add to a post are shown with the post. The Earth map shows activity per city, and hides smaller areas that have too few reels.</li>
          <li><strong>Messages</strong> are visible to the people in the conversation, and to moderators if a message is reported.</li>
        </ul>
        <p>
          The licence ends when you delete the content or your account, except for: copies held in backups
          for a limited time; content that others received from you, such as messages; and copies we must
          keep by law or to handle a report or dispute.
        </p>
      </Section>

      <Section id="terms-ai" title="6. AI processing and outputs">
        <ul>
          <li>
            Free processing (the FAST and STUDIO engines) runs on our servers. Cloud AI processing sends the
            media you select, and the settings you choose, to third-party AI providers, currently fal.ai and
            the models it hosts (for example Luma Ray). These providers process the media only to produce your result.
          </li>
          <li>
            AI results can be inaccurate or unexpected, and can look different from your source. Check every
            result before you publish it. You are responsible for the outputs you publish or share.
          </li>
          <li>
            We claim no ownership of the outputs you create. Some outputs may not be protected by copyright
            in some countries, and the provider’s own terms may also apply to them.
          </li>
          <li>
            Do not use the tools to create misleading content about real people, sexual content of anyone
            without their consent, or content that infringes someone else’s rights.
          </li>
        </ul>
      </Section>

      <Section id="terms-rules" title="7. Community rules">
        <p>You must not use the Service to post, send, or do any of the following:</p>
        <ul>
          <li>Child sexual abuse material, or any sexualised content involving minors. We remove it, ban the account, and report it to the authorities.</li>
          <li>Intimate or sexual images of a person shared without their consent.</li>
          <li>Harassment, threats, hate speech, or content that encourages violence or self-harm.</li>
          <li>Content that infringes copyright, trademarks, privacy, or other rights.</li>
          <li>Spam, scams, impersonation, malware, or misleading links.</li>
          <li>Scraping, automated access, or bots, except through features we provide.</li>
          <li>Getting around rate limits, spending caps, invite-only registration, or other technical limits; probing or attacking our systems.</li>
          <li>Earning reel-reward credits with bots, scripts, fake views, or multiple accounts.</li>
          <li>Anything illegal where you live or where the content is viewed.</li>
        </ul>
      </Section>

      <Section id="terms-moderation" title="8. Reports, moderation, and blocking">
        <p>
          You can report users, posts, Reel Packs, comments, and messages, and you can block other users.
          Our moderators review reports. We may remove content, limit features, or suspend or close
          accounts that break these Terms or the law, or that put others at risk. We may act without notice
          when the risk is serious. To appeal a moderation decision,{' '}
          <Link to="/support?category=appeal">file an appeal</Link> or email <V k="contactEmail" />.
        </p>
      </Section>

      <Section id="terms-copyright" title="9. Copyright complaints">
        <p>
          If you believe content on ECHO infringes your copyright, send a notice to <V k="copyrightEmail" /> with:
          your contact details; a description of the work; the link to the content on ECHO; a statement that
          you believe in good faith that the use is not authorised; a statement that your notice is accurate
          and that you own the rights or may act for the owner; and your physical or electronic signature.
        </p>
        <p>
          We remove content when we receive a valid notice, and we tell the person who posted it, who may send
          a counter-notice. We close the accounts of repeat infringers.
        </p>
      </Section>

      <Section id="terms-credits" title="10. ECHO Credits">
        <ul>
          <li>
            ECHO Credits pay for cloud AI processing. 1 credit represents US$0.01 of service value. Current
            packs are US$5 for 500 credits, US$10 for 1,050 credits, and US$25 for 2,750 credits. The price
            shown at checkout applies. Stripe processes payments; we do not store your card details.
          </li>
          <li>
            Credits never expire. They are a licence to use the Service, not money or property. You cannot
            transfer, sell, or exchange them for cash, except where these Terms or the law say otherwise.
          </li>
          <li>
            Before a job runs, we show its cost in credits. When you submit the job, we hold (reserve) that
            amount. We charge each processing stage when it completes. If a stage fails, or the job never
            starts, the held credits for it return to your balance.
          </li>
          <li>
            <strong>Reward credits</strong> may be earned by watching reels, within daily limits. We may change
            or end the reward programme, and we may remove reward credits that were earned by breaking these Terms.
          </li>
          <li>
            <strong>Refunds:</strong> within {LEGAL.refundDays} days of a purchase, you can ask for a refund of the
            credits from that purchase that you have not spent. Email <V k="contactEmail" />. We do not refund
            spent credits or reward credits. This does not limit any refund rights you have under consumer law.
          </li>
          <li>
            If a payment is refunded or charged back, we remove the matching credits. Your balance can then
            go below zero, and you cannot start new credit-funded jobs until it is positive again.
          </li>
          <li>
            Unspent credits are lost when you delete your account. Ask for any refund you are due before you
            delete it. If we close the paid features of the Service, we will give at least 30 days’ notice
            and refund unspent purchased credits.
          </li>
          <li>You are responsible for any taxes on your purchases, unless we collect them at checkout.</li>
        </ul>
      </Section>

      <Section id="terms-byok" title="11. Personal fal.ai keys">
        <p>
          You can save your own fal.ai API key and use it instead of credits. Jobs that use your key are
          billed by fal.ai directly to your fal.ai account under fal.ai’s terms, and you are responsible for
          those charges. Our cost estimates are estimates only. We store your key encrypted, use it only for
          jobs you submit, and delete it when you remove it or delete your account.
        </p>
      </Section>

      <Section id="terms-vr" title="12. VR and WebXR safety">
        <ul>
          <li>Use a headset only in a clear, safe space, and stay aware of people, pets, and objects around you.</li>
          <li>Stop right away and rest if you feel dizzy, sick, or uncomfortable, or have eye strain. Take regular breaks.</li>
          <li>Follow your headset maker’s health and safety warnings. Children should use VR only as the headset maker allows.</li>
          <li>The VR experience uses your headset and hand position to render the scene and to respond to your controls.</li>
        </ul>
      </Section>

      <Section id="terms-third-party" title="13. Third-party services">
        <p>
          Parts of the Service rely on other companies: Stripe (payments), fal.ai and the model providers it
          hosts (AI processing), Tenor (GIF search in messages), OpenStreetMap contributors (map data), and
          our hosting and content-delivery providers. Their terms and policies also apply to those parts. We
          are not responsible for services we do not control.
        </p>
      </Section>

      <Section id="terms-privacy" title="14. Privacy">
        <p>
          Our <Link to="/privacy">Privacy Policy</Link> explains what personal data we collect, how we use it,
          which providers receive it, and how long we keep it. It is part of these Terms.
        </p>
      </Section>

      <Section id="terms-termination" title="15. Deleting your account and termination">
        <ul>
          <li>
            You can delete your account at any time in Profile settings. This removes your profile and your
            content from the Service. Messages you sent are hidden from the people you
            talked with and kept for moderation and safety.
          </li>
          <li>
            We keep purchase and credit records after deletion, because the law requires us to keep financial
            records. Backups are deleted on their normal schedule.
          </li>
          <li>
            We may suspend or close your account if you break these Terms, if the law requires it, or if your
            use creates risk or legal exposure for us or others.
          </li>
          <li>Sections 5 (for content already shared), 9, 10 (refunds and chargebacks), and 16 to 19 continue after your account ends.</li>
        </ul>
      </Section>

      <Section id="terms-disclaimers" title="16. Disclaimers">
        <p>
          The Service is provided “as is” and “as available”. As far as the law allows, we make no promises
          that it will be error-free, secure, or uninterrupted, or that AI results will meet your needs.
          Nothing in these Terms removes rights you have under consumer law that cannot be removed.
        </p>
      </Section>

      <Section id="terms-liability" title="17. Limitation of liability">
        <p>
          As far as the law allows, ECHO is not liable for indirect, incidental, special, or consequential
          losses, or for lost profits, data, or goodwill. Our total liability for any claim about the Service
          is limited to the greater of the amount you paid us in the 12 months before the claim, or US$50.
          These limits do not apply to liability that the law does not allow us to limit, such as for death
          or personal injury caused by negligence, or for fraud.
        </p>
      </Section>

      <Section id="terms-indemnity" title="18. Responsibility for your use">
        <p>
          If you break these Terms or the law, or your content infringes someone’s rights, and someone makes a
          claim against ECHO because of it, you agree to cover the reasonable costs of that claim, to the extent
          the law allows.
        </p>
      </Section>

      <Section id="terms-law" title="19. Governing law and disputes">
        <p>
          These Terms are governed by the laws of <V k="governingLaw" />. Disputes go to the courts of{' '}
          <V k="disputeVenue" />, unless consumer law where you live gives you the right to bring a claim in
          your local courts. Please contact us first; most problems can be solved quickly.
        </p>
      </Section>

      <Section id="terms-changes" title="20. Changes to these Terms">
        <p>
          We may update these Terms. For important changes, we will tell you in the Service or by email at
          least 14 days before they take effect, unless a change is needed sooner for legal or safety reasons.
          If you keep using the Service after a change takes effect, you accept the new Terms.
        </p>
      </Section>

      <Section id="terms-contact" title="21. Contact">
        <p>
          <V k="company" />, <V k="address" />. Email: <V k="contactEmail" />.
        </p>
        <p><Link to="/reels">Back to ECHO</Link></p>
      </Section>
    </article>
  );
}
