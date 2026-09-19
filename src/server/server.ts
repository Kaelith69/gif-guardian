import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {appendAudit} from './audit.ts'
import {initializeAutoMod, syncAutoMod} from './automod.ts'
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

type FormData = Record<string, unknown>

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(reqMsg.url ?? '/', 'http://localhost')

    const pathname = url.pathname

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/menu/restrict-gif'
    ) {
      await handleRestrictGifMenu(rspMsg)
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/menu/manage-restricted-gifs'
    ) {
      await handleManageRestrictedGifsMenu(rspMsg)
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/menu/sync-automod'
    ) {
      await handleInitializeAutoMod(rspMsg)
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/form/restrict-gif-submit'
    ) {
      await handleGifForm(reqMsg, rspMsg)
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/form/manage-restricted-gifs-submit'
    ) {
      await handleManageRestrictedGifsForm(reqMsg, rspMsg)
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/triggers/comment-delete'
    ) {
      await handleSourceDelete(reqMsg, rspMsg, 'comment')
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/triggers/post-delete'
    ) {
      await handleSourceDelete(reqMsg, rspMsg, 'post')
      return
    }

    writeJson(
      404,
      {
        error: 'Gif-Guardian endpoint not found.',
      },
      rspMsg,
    )
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Gif-Guardian server error.'

    console.error(`Gif-Guardian server error; ${message}`)

    writeJson(
      err instanceof RequestTooLargeError
        ? 413
        : err instanceof InvalidJsonError
          ? 400
          : 500,
      {
        error: message,
      },
      rspMsg,
    )
  }
}

async function getSubredditName(): Promise<string> {
  if (!context.subredditName) {
    throw new Error('Gif-Guardian could not determine the current subreddit.')
  }

  return context.subredditName
}

async function requireModerator(): Promise<{
  subredditName: string
  username: string
}> {
  const subredditName = await getSubredditName()
  const username = await reddit.getCurrentUsername()

  if (!username) {
    throw new Error('Gif-Guardian could not determine the current moderator.')
  }

  const moderators = await reddit
    .getModerators({
      subredditName,
    })
    .all()

  const isModerator = moderators.some(
    moderator => moderator.username.toLowerCase() === username.toLowerCase(),
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
  if (!context.commentId) {
    throw new Error('This Gif-Guardian action must be run on a comment.')
  }

  const comment = await reddit.getCommentById(context.commentId)

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
  await requireModerator()

  const {comment, giphyIds} = await getCommentContext()

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
      {showToast: 'There are no restricted GIFs to manage.'},
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
            records.length === 0
              ? 'There are no restricted GIFs.'
              : 'Select a GIF and choose whether to disable or restore it.',
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
                {label: 'Disable', value: 'disabled'},
                {label: 'Restore', value: 'active'},
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

async function handleGifForm(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const {subredditName, username} = await requireModerator()

  const {comment, giphyIds} = await getCommentContext()

  const existingAction = await getActionResult(comment.id)

  if (existingAction) {
    writeJson<UiResponse>(200, {showToast: existingAction.message}, rspMsg)
    return
  }

  const form = await readJson<FormData>(reqMsg)

  const claimed = await claimAction(comment.id, {
    status: 'partial',
    giphyIds,
    message: 'Restriction is already being processed.',
  })

  if (!claimed) {
    const result = await getActionResult(comment.id)

    writeJson<UiResponse>(
      200,
      {showToast: result?.message ?? 'Restriction is already being processed.'},
      rspMsg,
    )
    return
  }

  const reason =
    typeof form.reason === 'string' && form.reason.trim().length > 0
      ? form.reason.trim().slice(0, 200)
      : 'pookie_cm'

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
      message: `Restriction failed: ${error}`,
    })
    throw error
  }

  let syncError: unknown
  try {
    await syncAutoMod(subredditName)
  } catch (err) {
    syncError = err
  }

  let removedAsSpam = false

  try {
    await reddit.remove(comment.id, true)
    removedAsSpam = true
  } catch (err) {
    console.error(`Gif-Guardian could not spam-remove ${comment.id}; ${err}`)
  }

  await appendAudit({
    action:
      mutation.alreadyRestricted.length === giphyIds.length
        ? 'already-restricted'
        : syncError
          ? 'sync-error'
          : 'restrict',
    status: removedAsSpam && !syncError ? 'success' : 'partial',
    giphyIds,
    commentId: comment.id,
    postId: comment.postId,
    moderator: username,
    at: new Date().toISOString(),
    reason,
    removedComment: removedAsSpam,
    note: syncError
      ? `GIFs remain in Redis desired state, but AutoModerator sync failed: ${syncError}`
      : removedAsSpam
        ? undefined
        : 'GIFs were restricted, but spam removal failed.',
  })

  const result: ActionResult = {
    status: removedAsSpam && !syncError ? 'success' : 'partial',
    giphyIds,
    message: syncError
      ? `Restricted ${giphyIds.length} GIF(s), but AutoModerator sync failed.`
      : removedAsSpam
        ? `Restricted ${giphyIds.length} GIF(s) and removed the comment as spam.`
        : `Restricted ${giphyIds.length} GIF(s), but spam removal failed.`,
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

  let syncError: unknown

  try {
    await syncAutoMod(subredditName)
  } catch (error) {
    syncError = error
  }

  await appendAudit({
    action: form.action === 'disabled' ? 'disable' : 'restore',
    status: syncError ? 'partial' : 'success',
    giphyIds: [form.giphyId],
    commentId: existing.sourceComment,
    postId: existing.sourcePost,
    moderator: username,
    at: new Date().toISOString(),
    reason: existing.reason,
    note: syncError
      ? `Desired state retained, but AutoModerator sync failed: ${syncError}`
      : undefined,
  })

  writeJson<UiResponse>(
    200,
    {
      showToast: syncError
        ? `GIF ${form.giphyId} updated, but AutoModerator sync failed.`
        : `GIF ${form.giphyId} ${form.action === 'disabled' ? 'disabled' : 'restored'}.`,
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

async function handleInitializeAutoMod(rspMsg: ServerResponse): Promise<void> {
  const {subredditName, username} = await requireModerator()

  await initializeAutoMod(subredditName)

  await appendAudit({
    action: 'initialize-automod',
    status: 'success',
    moderator: username,
    at: new Date().toISOString(),
  })

  writeJson(
    200,
    {
      ok: true,
      message: 'Gif-Guardian AutoModerator block initialized.',
    },
    rspMsg,
  )
}

class RequestTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the 8192-byte limit.')
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

  reqMsg.on('data', chunk => {
    size += chunk.length

    if (size > 8192) {
      return
    }

    chunks.push(chunk)
  })

  await new Promise<void>((resolve, reject) => {
    reqMsg.on('end', () => resolve())
    reqMsg.on('error', reject)
  })

  if (size > 8192) {
    throw new RequestTooLargeError()
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as T
  } catch {
    throw new InvalidJsonError()
  }
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)

  rsp.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json',
  })

  rsp.end(body)
}
