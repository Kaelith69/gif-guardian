import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {appendAudit, listAudit} from './audit.ts'
import {getAutoModStatus, initializeAutoMod, syncAutoMod} from './automod.ts'
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

type ApiRequest = {
  giphyId?: unknown
  reason?: unknown
}

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
      pathname === '/internal/menu/open-dashboard'
    ) {
      await handleOpenDashboard(rspMsg)
      return
    }

    if (
      reqMsg.method === 'POST' &&
      pathname === '/internal/form/restrict-gif-submit'
    ) {
      await handleGifForm(reqMsg, rspMsg)
      return
    }

    if (reqMsg.method === 'GET' && pathname === '/api/state') {
      await handleState(rspMsg)
      return
    }

    if (reqMsg.method === 'POST' && pathname === '/api/disable') {
      await handleStatusChange(reqMsg, rspMsg, 'disabled')
      return
    }

    if (reqMsg.method === 'POST' && pathname === '/api/restore') {
      await handleStatusChange(reqMsg, rspMsg, 'active')
      return
    }

    if (reqMsg.method === 'POST' && pathname === '/api/initialize-automod') {
      await handleInitializeAutoMod(rspMsg)
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

  const now = new Date().toISOString()
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
    at: now,
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

async function handleOpenDashboard(rspMsg: ServerResponse): Promise<void> {
  await requireModerator()

  const post = await reddit.submitCustomPost({
    title: 'Gif-Guardian Dashboard',
  })

  writeJson<UiResponse>(
    200,
    {
      navigateTo: post.url,
    },
    rspMsg,
  )
}

async function handleState(rspMsg: ServerResponse): Promise<void> {
  await requireModerator()

  const gifs = await listRestrictedGifs()
  const audit = await listAudit(100)
  const subredditName = await getSubredditName()

  const automod = await getAutoModStatus(subredditName)

  writeJson(
    200,
    {
      gifs,
      audit,
      automod,
    },
    rspMsg,
  )
}

async function handleStatusChange(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
  status: 'active' | 'disabled',
): Promise<void> {
  const {subredditName, username} = await requireModerator()

  const request = await readJson<ApiRequest>(reqMsg)

  if (typeof request.giphyId !== 'string' || request.giphyId.trim() === '') {
    throw new Error('A valid GIPHY ID is required.')
  }

  const giphyId = request.giphyId.trim()
  const existing = await getRestrictedGif(giphyId)

  if (!existing) {
    throw new Error(`GIF ${giphyId} is not in the registry.`)
  }

  const updated = await setGifStatus(giphyId, status, username)

  if (!updated) {
    throw new Error(`GIF ${giphyId} is not in the registry.`)
  }

  let syncError: unknown

  try {
    await syncAutoMod(subredditName)
  } catch (err) {
    syncError = err
  }

  await appendAudit({
    action: status === 'disabled' ? 'disable' : 'restore',
    status: syncError ? 'partial' : 'success',
    giphyIds: [giphyId],
    commentId: existing.sourceComment,
    postId: existing.sourcePost,
    moderator: username,
    at: new Date().toISOString(),
    reason: existing.reason,
    note: syncError
      ? `Desired state retained, but AutoModerator sync failed: ${syncError}`
      : undefined,
  })

  writeJson(
    200,
    {
      ok: !syncError,
      gif: updated,
      syncError: syncError ? String(syncError) : undefined,
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
