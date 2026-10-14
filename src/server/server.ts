import type {IncomingMessage, ServerResponse} from 'node:http'
import {reddit} from '@devvit/reddit'
import {context} from '@devvit/server'
import type {PartialJsonValue, UiResponse} from '@devvit/shared'

import {appendAudit} from './audit.ts'
import {syncAutoMod} from './automod.ts'
import {extractGiphyIds} from './gif-parser.ts'
import {mutateRestrictions, removeSourceReference} from './gif-store.ts'
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

      case '/internal/menu/sync-automod':
        await handleSyncAutoMod(rspMsg)
        return

      case '/internal/form/restrict-gif-submit':
        await handleRestrictGifForm(reqMsg, rspMsg)
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

  const user = await reddit.getCurrentUser()

  if (!user) {
    throw new Error('Gif-Guardian could not determine the current moderator.')
  }

  const permissions = await user.getModPermissionsForSubreddit(subredditName)

  if (permissions.length === 0) {
    throw new Error('Moderator access is required for Gif-Guardian.')
  }

  return {
    subredditName,
    username: user.username,
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
  writeJson<UiResponse>(
    200,
    {
      showForm: {
        name: 'restrictGif',
        form: {
          title: 'Restrict GIF',
          description:
            'This will validate GIFs in the selected comment, restrict them, ' +
            'update AutoModerator, ' +
            'and remove this comment as spam.',
          fields: [],
          acceptLabel: 'Restrict + Spam Remove',
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
  const [moderator, commentContext] = await Promise.all([
    requireModerator(),
    getCommentContext(),
  ])

  const {subredditName, username} = moderator
  const {comment, giphyIds} = commentContext

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

  await readJson<FormData>(reqMsg)

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

  const [syncOutcome, removalOutcome] = await Promise.all([
    (async () => {
      try {
        return {
          result: await syncAutoMod(subredditName),
          error: undefined,
        }
      } catch (error) {
        return {
          result: undefined,
          error,
        }
      }
    })(),
    (async () => {
      try {
        await reddit.remove(comment.id, true)

        return {
          removed: true,
        }
      } catch (error) {
        console.error(
          `Gif-Guardian could not spam-remove ${comment.id}; ${formatError(
            error,
          )}`,
        )

        return {
          removed: false,
        }
      }
    })(),
  ])

  const syncResult = syncOutcome.result
  const syncError = syncOutcome.error
  const removedAsSpam = removalOutcome.removed

  const syncPending = syncResult?.status === 'pending'

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

    writeJson<UiResponse>(
      200,
      {
        showToast: pending
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
