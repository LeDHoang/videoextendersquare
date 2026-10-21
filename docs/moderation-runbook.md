# Moderation runbook — invite-only beta

How reports and support requests are handled while the beta is invite-only. The
legal points marked **(confirm with lawyer)** are working assumptions, not advice.

## Who moderates

- Moderators are the addresses in `SX_MODERATOR_USERS`. Admins (`SX_ADMIN_USERS`)
  are moderators too, and only admins can reinstate accounts or suspend moderators.
- For the beta, the operator is the only admin. Add one invited moderator once the
  beta has more than about 50 active users.
- Check the queue at `/moderation` **at least twice a day** (morning and evening),
  and as soon as a support notification email arrives (`SX_SUPPORT_EMAIL`).

## Response targets

| Severity | Examples | First action | Target |
|---|---|---|---|
| S1 | Child sexual abuse material, credible threat of violence, doxxing, non-consensual intimate images | Remove the content, suspend the account, purge the CDN (§Takedowns) | Within 1 hour of seeing it; check notifications often enough that this is under 24 hours |
| S2 | Harassment, hate, copyright notice, privacy request | Review and act | Within 24 hours |
| S3 | Spam, mild rule breaks, appeals, bugs, account questions | Review and reply | Within 72 hours |

For S1, preserve what you need for a report to the authorities **before** deleting
(the report row and its encrypted evidence stay after removal). Reporting duties
for illegal content differ by country **(confirm with lawyer)**.

## The queue

`/moderation` has two tabs:

- **Reports**: user reports on posts, packs, comments, messages and users.
- **Support**: requests from `/support`. Categories are `appeal`, `copyright`,
  `privacy`, `account`, `bug`, `report_content` and `other`.

Report actions (`PATCH /api/moderation/reports/{id}`):

| Action | Use when | What it does |
|---|---|---|
| `dismiss` | The report is wrong or the content follows the rules | Closes the report; nothing changes |
| `resolve` | Handled outside the app (a reply, a warning) | Closes the report; nothing changes |
| `remove_content` | The post, pack, comment or message breaks the rules | Post: marked deleted and its media deleted from the bucket. Pack: marked deleted. Comment or message: hidden (`deleted_at`); a removed message disappears live from the conversation. Not available on user reports. |
| `suspend_user` | Serious or repeated breaks | Suspends the account and signs it out everywhere. Admins cannot be suspended, moderators only by an admin, and nobody can suspend themselves. |
| `reinstate_user` | An appeal succeeds | **Admin only.** Sets a suspended account back to active. Works on the report that led to the suspension, even after it was reviewed; it closes that report if it is still open. Deleted accounts cannot be reinstated (409 `ACCOUNT_DELETED`). |

Every action is logged with the moderator, the action and the note. Write a note on
every action that is not `dismiss`: it is the record an appeal is judged against.

Removing a post deletes the bucket object, but the edge can serve a cached copy for
up to a day. For S1 and copyright cases, also follow **Takedowns** below.

## Message evidence

- A message report stores an encrypted copy of the reported message only (not
  the messages around it), so moderators can read it even if the sender later
  deletes the message or the account. Ask the reporter for screenshots when the
  context matters.
- Messages of a deleted account are hidden from the other participants but kept,
  so reports on them can still be reviewed and acted on.
- Open evidence only for the report you are handling. Do not copy it out of the
  app except for an S1 report to the authorities.
- The evidence is encrypted with `SX_MESSAGE_ENCRYPTION_KEY`. If that key is lost,
  it cannot be read (`docs/deploy-runbook.md` §Secret escrow).

## Support requests

Each request has a status: `open`, `in_progress` or `closed`. Set `in_progress`
when you start and `closed` with a note when you finish. The requester sees the
request ID on screen; there is no automatic email reply. Reply from the operator
mailbox to the email on the request (signed-out requests always have one; for
signed-in ones, use the account's email).

- **`report_content`**: when the requester was signed in and the link pointed at a
  post, pack or profile, a report was filed automatically and shows in the Reports
  tab. For a signed-out request, use **File report** on the support request to turn
  the link into a report, then handle it in the Reports tab.
- **`appeal`**: find the report that led to the suspension (Reports tab, filter
  reviewed). An admin who agrees applies `reinstate_user` to that report, then closes
  the appeal. A refused appeal is closed with a short reason. One appeal per
  suspension; a second appeal about the same suspension can be closed with a link
  to the first.
- **`privacy`**: requests to see or delete personal data. Deleting the account in
  Settings covers most cases; point the user there. For anything else, reply within
  30 days **(confirm with lawyer** for the deadline in your jurisdiction**)**.
- **`copyright`**: see below.
- **`bug`**, **`account`**, **`other`**: reply and close.

Support emails carry only the category, ID and subject. The body is only in the app.

## Copyright

A valid notice (the contents are listed in the Terms, section 9) must include:

- the complainant's contact details;
- the copyrighted work;
- the link to the content on ECHO;
- a good-faith statement that the use is not authorised;
- a statement that the notice is accurate and that the sender owns the rights or
  may act for the owner;
- a physical or electronic signature.

Process:

1. Check that the notice is complete. If it is not, reply asking for what is
   missing and leave the content up.
2. Remove the content (`remove_content` on a report, or file one from the support
   request), then purge the CDN (§Takedowns).
3. Tell the uploader what was removed and that they may send a counter-notice to
   the copyright address.
4. A counter-notice is forwarded to the complainant. Restoring content after a
   counter-notice needs a waiting period and a re-upload by the user, because a
   removed post's media is deleted **(confirm with lawyer)**.
5. Repeat infringers: suspend an account after its **third** valid notice.
   Record each notice in the report note so the count is visible.

Whether a designated DMCA agent must be registered, and which address the Terms
list for notices, needs a lawyer before the public launch **(confirm with lawyer)**.

## Takedowns

For S1 and copyright removals, follow `docs/deploy-runbook.md` §5: remove in the
app, purge every media URL of the post by URL in Cloudflare, then check that
`curl -sI` returns `404` with no `cf-cache-status: HIT`.
