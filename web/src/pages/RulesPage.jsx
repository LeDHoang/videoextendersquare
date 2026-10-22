import { Link } from 'react-router-dom';
import { Section, V } from '../components/legal/LegalKit.jsx';

/*
 * Community rules: a plain-language summary of Terms §7–9. The Terms stay authoritative; keep both
 * pages in sync when a rule changes. Contact values come from components/legal/LegalKit.jsx.
 */
export default function RulesPage() {
  return (
    <article className="sx-legal">
      <header className="sx-ps-head">
        <div>
          <h1 className="sx-ps-title">COMMUNITY RULES</h1>
          <div className="sx-ps-kicker">WHAT YOU CAN POST AND SEND ON ECHO</div>
        </div>
      </header>

      <Section id="rules-scope" title="1. Who these rules cover">
        <p>
          These rules apply to everything on ECHO: posts, reels, Reel Packs, captions, comments, profiles,
          and direct messages. They summarise the community rules in our <Link to="/terms">Terms of Service</Link>,
          which take priority if the two ever differ.
        </p>
      </Section>

      <Section id="rules-forbidden" title="2. What is not allowed">
        <ul>
          <li><strong>Illegal content:</strong> anything illegal where you live or where the content is viewed.</li>
          <li><strong>Sexual content involving minors:</strong> child sexual abuse material, or any sexualised content involving minors. We remove it, ban the account, and report it to the authorities.</li>
          <li><strong>Non-consensual content:</strong> intimate or sexual images of a person shared without their consent, or sexual content of anyone made without their consent, including AI-edited images.</li>
          <li><strong>Harassment:</strong> bullying, threats, hate speech, or content that encourages violence or self-harm.</li>
          <li><strong>Copyright infringement:</strong> content you do not own or have permission to use, including other people’s videos, music, and photos.</li>
          <li><strong>Spam:</strong> repeated or unwanted posts and messages, scams, impersonation, malware, misleading links, and fake views or bots.</li>
        </ul>
      </Section>

      <Section id="rules-moderation" title="3. Moderation and removal">
        <p>
          You can report posts, Reel Packs, comments, messages, and users, and you can block other users.
          Our moderators review reports. When content breaks these rules, we may remove it, limit features,
          or suspend or close the account. We may act without notice when the risk is serious.
        </p>
      </Section>

      <Section id="rules-appeal" title="4. Appeals">
        <p>
          If you think we removed your content or limited your account by mistake,{' '}
          <Link to="/support?category=appeal">file an appeal</Link> (it works while signed out, including
          for suspended accounts) or email <V k="contactEmail" />. Include your username and a link to the
          content or a description of the decision. We review every appeal. For copyright complaints, email{' '}
          <V k="copyrightEmail" />.
        </p>
        <p><Link to="/reels">Back to ECHO</Link></p>
      </Section>
    </article>
  );
}
