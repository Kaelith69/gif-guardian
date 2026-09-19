import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'

import {appendAudit} from './audit.ts'
import {type SyncResult, syncAutoMod} from './automod.ts'
import {extractGiphyIds} from './gif-parser.ts'
import {
  getRestrictedGif,
  listRestrictedGifs,
  mutateRestrictions,
  removeSourceReference,
  setGifStatus,
} from './gif-store.ts'
import {
  type ActionResult,
  claimAction,
  getActionResult,
  saveActionResult,
} from './state.ts'

const MAX_REQUEST_BODY_BYTES = 8_192

type FormData = Record<string, unknown>

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(reqMsg.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (reqMsg.method !== 'POST') {
      writeJson(405, {error: 'Method not allowed.'}, rspMsg)
      return
    }

    switch (pathname) {
      case '/internal/menu/restrict-gif':
        await handleRestrictGifMenu(rspMsg)
        return

      case '/internal/menu/manage-restricted-gifs':
        await handleManageRestrictedGifsMenu(rspMsg)
        return

      case '/internal/menu/sync-automod':
        await handleSyncAutoMod(rspMsg)
        return

      case '/internal/form/restrict-gif-submit':
        await handleRestrictGifForm(reqMsg, rspMsg)
        return

      case '/internal/form/manage-restricted-gifs-submit':
        await handleManageRestrictedGifsForm(reqMsg, rspMsg)
        return

      case '/internal/triggers/comment-delete':
        await handleSourceDelete(reqMsg, rspMsg, 'comment')
        return

      case '/internal/triggers/post-delete':
        await handleSourceDelete(reqMsg, rspMsg, 'post')
        return

      default:
        writeJson(
          404,
          {
            error: 'Gif-Guardian endpoint not found.',
          },
          rspMsg,
        )
    }
  } catch (error) {
    const message = formatError(error)

    console.error(`Gif-Guardian server error; ${message}`)

    const status =
      error instanceof RequestTooLargeError
        ? 413
        : error instanceof InvalidJsonError
          ? 400
          : 500

    writeJson(status, {error: message}, rspMsg)
  }
}

async function getSubredditName(): Promise<string> {
  const subredditName = context.subredditName

  if (!subredditName) {
    throw new Error('Gif-Guardian could not determine the current subreddit.')
  }

  return subredditName
}

async function requireModerator(): Promise<{
  subredditName: string
  username: string
}> {
  const subredditName = await getSubredditName()

  const [username, moderators] = await Promise.all([
    reddit.getCurrentUsername(),
    reddit.getModerators({subredditName}).all(),
  ])

  if (!username) {
    throw new Error('Gif-Guardian could not determine the current moderator.')
  }

  const normalizedUsername = username.toLowerCase()

  const isModerator = moderators.some(
    moderator => moderator.username.toLowerCase() === normalizedUsername,
  )

  if (!isModerator) {
    throw new Error('Moderator access is required for Gif-Guardian.')
  }

  return {
    subredditName,
    username,
  }
}

async function getCommentContext() {
  const commentId = context.commentId

  if (!commentId) {
    throw new Error('This Gif-Guardian action must be run on a comment.')
  }

  const comment = await reddit.getCommentById(commentId)

  const giphyIds = extractGiphyIds(comment.body)

  if (giphyIds.length === 0) {
    throw new Error('No supported GIPHY GIF was found in this comment.')
  }

  return {
    comment,
    giphyIds,
  }
}

async function handleRestrictGifMenu(rspMsg: ServerResponse): Promise<void> {
  const [, commentContext] = await Promise.all([
    requireModerator(),
    getCommentContext(),
  ])

  const {comment, giphyIds} = commentContext

  writeJson<UiResponse>(
    200,
    {
      showForm: {
        name: 'restrictGif',
        form: {
          title: 'Restrict GIF',
          description:
            `GIF(s) detected: ${giphyIds.join(', ')}\n` +
            `Comment: ${comment.id}\n\n` +
            'This will restrict the GIF(s), update AutoModerator, ' +
            'and remove this comment as spam.',
          fields: [
            {
              type: 'string',
              name: 'reason',
              label: 'Reason',
              defaultValue: 'pookie_cm',
              required: true,
            },
          ],
          acceptLabel: 'Restrict + Spam Remove',
          cancelLabel: 'Cancel',
        },
      },
    },
    rspMsg,
  )
}

async function handleManageRestrictedGifsMenu(
  rspMsg: ServerResponse,
): Promise<void> {
  await requireModerator()

  const records = await listRestrictedGifs()

  if (records.length === 0) {
    writeJson<UiResponse>(
      200,
      {
        showToast: 'There are no restricted GIFs to manage.',
      },
      rspMsg,
    )
    return
  }

  writeJson<UiResponse>(
    200,
    {
      showForm: {
        name: 'manageRestrictedGifs',
        form: {
          title: 'Manage Restricted GIFs',
          description:
            'Select a GIF and choose whether to disable or restore it.',
          fields: [
            {
              type: 'select',
              name: 'giphyId',
              label: 'GIF',
              options: records.map(record => ({
                label: `${record.giphyId} (${record.status})`,
                value: record.giphyId,
              })),
              required: true,
            },
            {
              type: 'select',
              name: 'action',
              label: 'Action',
              options: [
                {
                  label: 'Disable',
                  value: 'disabled',
                },
                {
                  label: 'Restore',
                  value: 'active',
                },
              ],
              required: true,
            },
          ],
          acceptLabel: 'Apply',
          cancelLabel: 'Cancel',
        },
      },
    },
    rspMsg,
  )
}

async function handleRestrictGifForm(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const {subredditName, username} = await requireModerator()

  const {comment, giphyIds} = await getCommentContext()

  const existingAction = await getActionResult(comment.id)

  if (existingAction) {
    writeJson<UiResponse>(
      200,
      {
        showToast: existingAction.message,
      },
      rspMsg,
    )
    return
  }

  const form = await readJson<FormData>(reqMsg)

  const reason =
    typeof form.reason === 'string' && form.reason.trim().length > 0
      ? form.reason.trim().slice(0, 200)
      : 'pookie_cm'

  /*
   * Parse the form before claiming the action so malformed input
   * cannot leave a ten-minute "processing" claim behind.
   */
  const claimed = await claimAction(comment.id, {
    status: 'partial',
    giphyIds,
    message: 'Restriction is already being processed.',
  })

  if (!claimed) {
    const result = await getActionResult(comment.id)

    writeJson<UiResponse>(
      200,
      {
        showToast: result?.message ?? 'Restriction is already being processed.',
      },
      rspMsg,
    )
    return
  }

  let mutation

  try {
    mutation = await mutateRestrictions(
      giphyIds.map(giphyId => ({
        giphyId,
        reason,
        username,
        sourceComment: comment.id,
        sourceUrl: comment.url,
        sourcePost: comment.postId,
      })),
    )
  } catch (error) {
    await saveActionResult(comment.id, {
      status: 'partial',
      giphyIds,
      message: `Restriction failed: ${formatError(error)}`,
    })

    throw error
  }

  let syncResult: SyncResult | undefined

  let syncError: unknown

  try {
    syncResult = await syncAutoMod(subredditName)
  } catch (error) {
    syncError = error
  }

  const syncPending = syncResult?.status === 'pending'

  let removedAsSpam = false

  try {
    await reddit.remove(comment.id, true)
    removedAsSpam = true
  } catch (error) {
    console.error(
      `Gif-Guardian could not spam-remove ${comment.id}; ${formatError(error)}`,
    )
  }

  const action =
    mutation.alreadyRestricted.length === giphyIds.length
      ? 'already-restricted'
      : syncError
        ? 'sync-error'
        : 'restrict'

  const status =
    removedAsSpam && !syncError && !syncPending ? 'success' : 'partial'

  const note = syncError
    ? `GIFs remain in Redis desired state, but AutoModerator sync failed: ${formatError(
        syncError,
      )}`
    : syncPending
      ? 'GIFs remain in Redis desired state, but AutoModerator synchronization is still pending.'
      : removedAsSpam
        ? undefined
        : 'GIFs were restricted, but spam removal failed.'

  await appendAudit({
    action,
    status,
    giphyIds,
    commentId: comment.id,
    postId: comment.postId,
    moderator: username,
    at: new Date().toISOString(),
    reason,
    removedComment: removedAsSpam,
    note,
  })

  let message: string

  if (syncError) {
    message = `Restricted ${giphyIds.length} GIF(s), but AutoModerator sync failed.`
  } else if (syncPending) {
    message = removedAsSpam
      ? `Restricted ${giphyIds.length} GIF(s), removed the comment as spam, and left AutoModerator sync pending.`
      : `Restricted ${giphyIds.length} GIF(s), but AutoModerator sync is pending and spam removal failed.`
  } else if (removedAsSpam) {
    message = `Restricted ${giphyIds.length} GIF(s) and removed the comment as spam.`
  } else {
    message = `Restricted ${giphyIds.length} GIF(s), but spam removal failed.`
  }

  const result: ActionResult = {
    status,
    giphyIds,
    message,
  }

  await saveActionResult(comment.id, result)

  writeJson<UiResponse>(
    200,
    {
      showToast: result.message,
    },
    rspMsg,
  )
}

async function handleManageRestrictedGifsForm(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const {subredditName, username} = await requireModerator()

  const form = await readJson<{
    giphyId?: unknown
    action?: unknown
  }>(reqMsg)

  if (
    typeof form.giphyId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(form.giphyId) ||
    (form.action !== 'active' && form.action !== 'disabled')
  ) {
    throw new Error('A valid GIF and management action are required.')
  }

  const existing = await getRestrictedGif(form.giphyId)

  if (!existing) {
    throw new Error(`GIF ${form.giphyId} is not in the registry.`)
  }

  const updated = await setGifStatus(form.giphyId, form.action, username)

  if (!updated) {
    throw new Error(`GIF ${form.giphyId} is not in the registry.`)
  }

  let syncResult: SyncResult | undefined

  let syncError: unknown

  try {
    syncResult = await syncAutoMod(subredditName)
  } catch (error) {
    syncError = error
  }

  const syncPending = syncResult?.status === 'pending'

  await appendAudit({
    action: form.action === 'disabled' ? 'disable' : 'restore',
    status: syncError || syncPending ? 'partial' : 'success',
    giphyIds: [form.giphyId],
    commentId: existing.sourceComment,
    postId: existing.sourcePost,
    moderator: username,
    at: new Date().toISOString(),
    reason: existing.reason,
    note: syncError
      ? `Desired state retained, but AutoModerator sync failed: ${formatError(
          syncError,
        )}`
      : syncPending
        ? 'Desired state updated, but AutoModerator synchronization is still pending.'
        : undefined,
  })

  const message = syncError
    ? `GIF ${form.giphyId} updated, but AutoModerator sync failed.`
    : syncPending
      ? `GIF ${form.giphyId} updated, but AutoModerator synchronization is still pending.`
      : `GIF ${form.giphyId} ${
          form.action === 'disabled' ? 'disabled' : 'restored'
        }.`

  writeJson<UiResponse>(
    200,
    {
      showToast: message,
    },
    rspMsg,
  )
}

async function handleSourceDelete(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
  sourceType: 'comment' | 'post',
): Promise<void> {
  const request = await readJson<{
    sourceId?: unknown
    commentId?: unknown
    postId?: unknown
  }>(reqMsg)

  const sourceId =
    request.sourceId ??
    (sourceType === 'comment' ? request.commentId : request.postId)

  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    throw new Error('A valid sourceId is required.')
  }

  await removeSourceReference(sourceId, sourceType)

  writeJson(200, {ok: true}, rspMsg)
}

async function handleSyncAutoMod(rspMsg: ServerResponse): Promise<void> {
  const {subredditName, username} = await requireModerator()

  try {
    const result = await syncAutoMod(subredditName)

    const pending = result.status === 'pending'

    await appendAudit({
      action: 'sync',
      status: pending ? 'partial' : 'success',
      moderator: username,
      at: new Date().toISOString(),
      note: pending
        ? `AutoModerator synchronization remains pending at registry revision ${result.revision}.`
        : undefined,
    })

    writeJson(
      200,
      {
        ok: true,
        status: result.status,
        message: pending
          ? 'Gif-Guardian AutoModerator synchronization is still pending.'
          : 'Gif-Guardian AutoModerator is synchronized.',
      },
      rspMsg,
    )
  } catch (error) {
    await appendAudit({
      action: 'sync-error',
      status: 'partial',
      moderator: username,
      at: new Date().toISOString(),
      note: `Manual AutoModerator sync failed: ${formatError(error)}`,
    })

    throw error
  }
}

class RequestTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`)
    this.name = 'RequestTooLargeError'
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('Request body must be valid JSON.')
    this.name = 'InvalidJsonError'
  }
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  let size = 0

  await new Promise<void>((resolve, reject) => {
    reqMsg.on('data', chunk => {
      size += chunk.length

      if (size <= MAX_REQUEST_BODY_BYTES) {
        chunks.push(chunk)
      }
    })

    reqMsg.on('end', resolve)
    reqMsg.on('error', reject)
  })

  if (size > MAX_REQUEST_BODY_BYTES) {
    throw new RequestTooLargeError()
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new InvalidJsonError()
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)

  rsp.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })

  rsp.end(body)
}
