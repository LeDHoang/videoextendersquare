# Private posts design

Date: 2026-11-16. Source: operator decisions in the session of that day, recorded in `docs/todolist.md` → "Still open" → "High priority".

## What it is

A post has a visibility: `public` (default) or `private`. A creator picks it when publishing and can change it later, in both directions.

A private post is **unlisted, not locked**. It is visible to its creator and to anyone who opens its direct link. It is not access control: the media files stay at their public `media.<domain>` URLs.

## Operator decisions

1. A private post is visible to its creator, and to anyone who opens its direct link (`/reels?post=<id>`), signed in or not.
2. It appears nowhere else: feeds, Explore, search, tag and location pages, recommendations, the profile as other people see it.
3. Likes, comments, saves and reports stay available on a private post.
4. A private post already shared in a DM still opens from that message.
5. In a Reel Pack, a private post is hidden from other viewers.
6. Hiding a whole pack is the existing UNLISTED pack setting. An unlisted pack's link also shows the pack owner's own private posts. Posts by other creators show only while they are public. A pack never changes a post's own visibility.

## Assumptions (mine, not yet confirmed by the operator)

- A1. The creator sees their own private posts in two places: their own profile grid (with a `PRIVATE` badge) and the player when opened from that grid or from the link. They do not appear in the creator's own For You, Following, Explore, search, tag or location lists.
- A2. The direct link is the canonical `/reels?post=<id>` link that the SHARE action already produces. A `play=<media path>` link does not open a private post for anyone but its creator.
- A3. Anyone who can open a private post may share it in a DM; that is the same as passing the link on.
- A4. Only the creator can add their private post to a pack. In a public pack a private member shows as unavailable to everyone, the creator included, and does not count toward the pack's playable reels or supply its cover.
- A5. The saved list hides a post that turned private after it was saved; the save itself is kept, so it returns if the post turns public again.
- A6. The profile's like total counts public posts only. `post_count` is not changed by visibility, so the number on a profile can be higher than the posts other people see.
- A7. A blocked viewer, a suspended creator and a deleted post still give 404 through the link, as for a public post.
- A8. Moderators see private posts in the staff console as they see any post.
- A9. No feature flag and no env setting.

## Known limits

- Anonymous list responses are cached at the Cloudflare edge for 30 s (`server/edge_cache.py`), and each app process keeps reel records for 10 s. A post turned private can stay in an anonymous list for up to about 30 s.
- A person who has the media file's URL can still fetch the file.

## UI copy

- Toggle label: `PRIVATE POST`
- Help line under the toggle: `Only you and anyone with the link can see it.`
- Tile badge: `PRIVATE`
