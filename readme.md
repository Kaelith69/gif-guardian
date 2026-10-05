## What it does

Gif-Guardian helps subreddit moderators stop unwanted GIPHY GIFs from repeatedly appearing in comments.

A moderator can select **Gif-Guardian: Restrict GIF** on a comment. The app identifies the GIF, records the restriction, updates AutoModerator, and removes the current comment as spam.

Future comments containing the restricted GIF can then be automatically caught by AutoModerator.

## How it does it

```text
Moderator selects a GIF
        ↓
Extract GIPHY ID
        ↓
Store restriction in Redis
        ↓
Generate/update managed AutoModerator rule
        ↓
Remove current comment as spam
        ↓
Future matches → AutoModerator
```

Redis stores the restriction state, while Gif-Guardian maintains a dedicated AutoModerator section without modifying unrelated rules.

## Use cases

- Repeatedly posted unwanted GIFs
- GIF spam in large subreddits
- Moderators who want to turn one manual removal into automatic enforcement
- Subreddits that want persistent GIF restrictions without manually editing AutoModerator
- Temporarily disabling and later restoring GIF restrictions