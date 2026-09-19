# Gif-Guardian Moderator Guide

Gif-Guardian lets moderators restrict a GIPHY GIF once, remove the current comment as spam, and have AutoModerator spam-remove future comments containing that same GIF.

For the technical design and local development commands, see the [README](readme.md).

## Before you start

You need to be a moderator of the target subreddit. The app uses Reddit's native moderator menus, so no separate dashboard or account setup is required.

Before using the app in a production community, test it in a private or dedicated test subreddit. In particular, make sure moderators are comfortable with the app's `action: spam` AutoModerator behavior.

## Restrict a GIF

1. Open a comment containing a GIPHY embed.
2. Open the comment moderation menu.
3. Select **Gif-Guardian: Restrict GIF**.
4. Enter a reason, then choose **Restrict + Spam Remove**.

The confirmation form opens immediately. After confirmation, Gif-Guardian validates the selected comment, stores every supported GIPHY ID it finds, synchronizes AutoModerator, and removes that comment as spam.

The result toast explains whether the restriction, AutoModerator synchronization, and spam removal all completed. Repeating the same request is safe: it is protected from duplicate action processing for a short period.

### Supported GIF format

The comment must contain a Reddit GIPHY embed in this form:

```text
![gif](giphy|GIF_ID)
```

Embeds with extra display parameters are also supported, for example:

```text
![gif](giphy|GIF_ID|width=400&height=300)
```

If the comment contains no supported GIPHY GIF, no restriction is saved.

## Manage an existing restriction

From the subreddit moderator menu, select **Gif-Guardian: Manage Restricted GIFs**.

Choose a GIF and one of these actions:

- **Disable**: keeps the record for history but removes it from the active AutoModerator rules.
- **Restore**: makes a previously disabled GIF active again.

Use Disable when the GIF should be allowed again but you want to retain its moderation history. Use Restore to reapply a disabled restriction.

## Synchronize AutoModerator manually

Select **Gif-Guardian: Sync AutoModerator** from the subreddit moderator menu when:

- a restriction or management action reports that synchronization is pending;
- a previous sync failed; or
- you want to confirm that AutoModerator matches the current registry.

Gif-Guardian only changes the section between these markers in `config/automoderator`:

```text
# === COCONAAD GIF GUARD START ===
...
# === COCONAAD GIF GUARD END ===
```

Do not duplicate, delete, or reorder these markers. Other AutoModerator rules outside that section are left untouched.

## Understanding results

| Result | Meaning | What to do |
| --- | --- | --- |
| Restricted and removed | The GIF restriction, AutoModerator sync, and spam removal completed. | No action needed. |
| Sync pending | The restriction was saved, but the current AutoModerator projection is not yet confirmed. | Run **Sync AutoModerator** shortly afterwards. |
| Sync failed | The restriction remains safely stored, but Reddit's AutoModerator page was not updated. | Run **Sync AutoModerator**; check the page markers if it continues failing. |
| Spam removal failed | The GIF restriction was saved and AutoModerator may be updated, but the current comment was not removed. | Remove the comment manually and retry sync if required. |
| No supported GIPHY GIF | The selected comment did not contain a supported GIPHY embed. | Choose a comment containing a supported embed. |

## Playtest checklist

Use this checklist before deploying an updated version:

1. Start a playtest in the configured test subreddit.
2. Post a comment with a supported GIPHY embed.
3. Select **Restrict GIF** and confirm that the form appears immediately.
4. Submit a reason and verify that the comment is marked as spam.
5. Check `config/automoderator` for the managed Gif-Guardian block.
6. Post a new comment with the same GIF and verify that AutoModerator removes it as spam.
7. Disable the GIF through **Manage Restricted GIFs** and synchronize.
8. Post the same GIF again and verify it is no longer matched by the managed rule.
9. Restore the GIF and verify that matching resumes after synchronization.

## Troubleshooting

**The confirmation form does not show.** Refresh Reddit, make sure you opened the menu on a comment, and confirm that you are a moderator.

**The form says no supported GIPHY GIF was found.** The app only recognizes Reddit GIPHY embeds. Plain GIPHY links, GIFs hosted elsewhere, and malformed embed text are not restrictions.

**Synchronization keeps failing.** Open `config/automoderator` and make sure there is exactly one start marker and one end marker, in that order. Do not edit the text of the markers.

**A GIF is still being removed after I disabled it.** Run **Sync AutoModerator** and wait for a successful result. The registry is the source of truth, but the AutoModerator wiki page must be synchronized before Reddit can apply the change.

**A current comment was not removed.** The GIF record may still be restricted. Remove that one comment manually, then use **Sync AutoModerator** if the result reported a pending or failed synchronization.
