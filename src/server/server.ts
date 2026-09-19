import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {appendAudit, listAudit} from './audit.ts'
import {getAutoModStatus, initializeAutoMod, syncAutoMod} from './automod.ts'
import {extractGiphyIds} from './gif-parser.ts'
import {
  deleteRestrictedGif,
  getRestrictedGif,
  listRestrictedGifs,
  saveRestrictedGif,
  saveRestrictedGifs,
} from './gif-store.ts'

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
      500,
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

  const form = await readJson<FormData>(reqMsg)

  const reason =
    typeof form.reason === 'string' && form.reason.trim().length > 0
      ? form.reason.trim().slice(0, 200)
      : 'pookie_cm'

  const existing = new Map<
    string,
    Awaited<ReturnType<typeof getRestrictedGif>>
  >()

  for (const giphyId of giphyIds) {
    existing.set(giphyId, await getRestrictedGif(giphyId))
  }

  const now = new Date().toISOString()

  const records = giphyIds.map(giphyId => ({
    giphyId,
    status: 'active' as const,
    reason,
    addedBy: username,
    addedAt: now,
    sourceComment: comment.id,
    sourcePost: comment.postId,
    originalUrl: `https://giphy.com/gifs/${giphyId}`,
  }))

  await saveRestrictedGifs(records)

  try {
    await syncAutoMod(subredditName)
  } catch (err) {
    for (const [giphyId, previous] of existing) {
      if (previous) {
        await saveRestrictedGif(previous)
      } else {
        await deleteRestrictedGif(giphyId)
      }
    }

    throw err
  }

  let removedAsSpam = false

  try {
    await reddit.remove(comment.id, true)
    removedAsSpam = true
  } catch (err) {
    console.error(`Gif-Guardian could not spam-remove ${comment.id}; ${err}`)
  }

  await appendAudit({
    action: 'restrict',
    status: removedAsSpam ? 'success' : 'partial',
    giphyIds,
    commentId: comment.id,
    postId: comment.postId,
    moderator: username,
    at: now,
    reason,
    removedComment: removedAsSpam,
    note: removedAsSpam
      ? undefined
      : 'GIFs were restricted and AutoModerator updated, but spam removal failed.',
  })

  writeJson<UiResponse>(
    200,
    {
      showToast: removedAsSpam
        ? `Restricted ${giphyIds.length} GIF(s) and removed the comment as spam.`
        : `Restricted ${giphyIds.length} GIF(s), but spam removal failed.`,
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

  const updated = {
    ...existing,
    status,
  }

  await saveRestrictedGif(updated)

  try {
    await syncAutoMod(subredditName)
  } catch (err) {
    await saveRestrictedGif(existing)
    throw err
  }

  await appendAudit({
    action: status === 'disabled' ? 'disable' : 'restore',
    status: 'success',
    giphyIds: [giphyId],
    commentId: existing.sourceComment,
    postId: existing.sourcePost,
    moderator: username,
    at: new Date().toISOString(),
    reason: existing.reason,
  })

  writeJson(
    200,
    {
      ok: true,
      gif: updated,
    },
    rspMsg,
  )
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

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []

  reqMsg.on('data', chunk => chunks.push(chunk))

  await new Promise<void>((resolve, reject) => {
    reqMsg.on('end', () => resolve())
    reqMsg.on('error', reject)
  })

  return JSON.parse(Buffer.concat(chunks).toString()) as T
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
