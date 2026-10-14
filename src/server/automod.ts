import {reddit} from '@devvit/reddit'
import {redis} from '@devvit/redis'

import type {RestrictedGif} from './gif.ts'
import {listRestrictedGifs} from './gif-store.ts'
import {
  AUTOMOD_LOCK_KEY,
  getRegistryState,
  LOCK_TTL_SECONDS,
  MAX_AUTOMOD_RULE_BYTES,
  updateRegistryState,
} from './state.ts'

const AUTOMOD_PAGE = 'config/automoderator'
const START_MARKER = '# === GIF GUARDIAN START ==='
const END_MARKER = '# === GIF GUARDIAN END ==='
const MAX_SYNC_ATTEMPTS = 3
const LOCK_RENEW_INTERVAL_MS = Math.floor((LOCK_TTL_SECONDS * 1_000) / 3)

export type SyncResult = {
  status: 'synced' | 'pending'
  revision: number
  activeCount: number
  wikiRevisionId: string | null
}

export function buildRule(
  ids: string[],
  type: 'comment' | 'submission' = 'comment',
): string {
  const escapedIds = ids.map(escapeRegex)
  const regex = `!\\[gif\\]\\(giphy\\|(${escapedIds.join('|')})(?:\\|[^)]*)?\\)`

  return [
    `type: ${type}`,
    `body (includes, regex): '${regex}'`,
    'action: spam',
    'moderators_exempt: false',
  ].join('\n')
}

export function buildUrlRule(ids: string[]): string {
  const escapedIds = ids.map(escapeRegex)
  const regex = `(?:giphy\\.com/gifs/[^\\s/?#]*-|media\\.giphy\\.com/media/)(${escapedIds.join('|')})(?:[/?#]|$)`

  return [
    'type: submission',
    `url (regex): '${regex}'`,
    'action: spam',
    'moderators_exempt: false',
  ].join('\n')
}

export function packIds(ids: string[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let currentSize = Math.max(
    Buffer.byteLength(buildRule([]), 'utf8'),
    Buffer.byteLength(buildUrlRule([]), 'utf8'),
  )

  for (const id of ids) {
    const idSize = Buffer.byteLength(escapeRegex(id), 'utf8')
    const candidateSize = currentSize + idSize + (current.length === 0 ? 0 : 1)

    if (current.length > 0 && candidateSize > MAX_AUTOMOD_RULE_BYTES) {
      groups.push(current)
      current = [id]
      currentSize = Math.max(
        Buffer.byteLength(buildRule([id]), 'utf8'),
        Buffer.byteLength(buildUrlRule([id]), 'utf8'),
      )
    } else {
      current.push(id)
      currentSize = candidateSize
    }
  }

  if (current.length > 0) groups.push(current)
  return groups
}

function escapeRegex(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type ActiveRestriction = Pick<RestrictedGif, 'giphyId'>

export function buildManagedBlock(
  restrictions: string[] | ActiveRestriction[],
): string {
  const ids = restrictions.map(restriction =>
    typeof restriction === 'string' ? restriction : restriction.giphyId,
  )
  const rules = packIds(ids).flatMap(group => [
    buildRule(group, 'comment'),
    buildRule(group, 'submission'),
    buildUrlRule(group),
  ])
  const body = rules.length
    ? rules.join('\n---\n')
    : '# Gif-Guardian: no active GIF restrictions.'

  return [START_MARKER, body, END_MARKER].join('\n')
}

export function ensureManagedBlock(content: string, block: string): string {
  const starts = findAllOccurrences(content, START_MARKER)
  const ends = findAllOccurrences(content, END_MARKER)

  if (starts.length === 0 && ends.length === 0) {
    if (content.length === 0) return `${block}\n`
    return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${block}\n`
  }

  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(
      'Gif-Guardian AutoModerator contains duplicate or incomplete markers.',
    )
  }

  const start = starts[0]
  const end = ends[0]

  if (start === undefined || end === undefined) {
    throw new Error('Gif-Guardian managed block markers are incomplete.')
  }
  if (end < start) {
    throw new Error(
      'Gif-Guardian AutoModerator markers are in the wrong order.',
    )
  }

  return (
    content.slice(0, start) + block + content.slice(end + END_MARKER.length)
  )
}

function findAllOccurrences(content: string, marker: string): number[] {
  const positions: number[] = []
  let offset = 0

  while (true) {
    const index = content.indexOf(marker, offset)
    if (index === -1) return positions
    positions.push(index)
    offset = index + marker.length
  }
}

class AutoModLeaseLostError extends Error {}

async function acquireLock(): Promise<string> {
  const token = crypto.randomUUID()
  const result = await redis.set(AUTOMOD_LOCK_KEY, token, {
    nx: true,
    expiration: new Date(Date.now() + LOCK_TTL_SECONDS * 1_000),
  })
  if (result !== 'OK') {
    throw new Error('Gif-Guardian AutoModerator sync is already in progress.')
  }
  return token
}

async function assertLockOwned(token: string): Promise<void> {
  if ((await redis.get(AUTOMOD_LOCK_KEY)) !== token) {
    throw new AutoModLeaseLostError()
  }
}

async function renewLock(token: string): Promise<void> {
  await assertLockOwned(token)
  await redis.expire(AUTOMOD_LOCK_KEY, LOCK_TTL_SECONDS)
}

async function releaseLock(token: string): Promise<void> {
  if ((await redis.get(AUTOMOD_LOCK_KEY)) === token) {
    await redis.del(AUTOMOD_LOCK_KEY)
  }
}

async function markSyncSuccess(revision: number, wikiRevisionId: string) {
  return updateRegistryState(revision, current => ({
    ...current,
    syncedRevision: revision,
    syncStatus: 'synced',
    lastSyncAt: new Date().toISOString(),
    lastSyncError: null,
    wikiRevisionId,
  }))
}

async function markSyncError(revision: number, error: unknown): Promise<void> {
  try {
    await updateRegistryState(revision, current => ({
      ...current,
      syncStatus: 'error',
      lastSyncError: error instanceof Error ? error.message : String(error),
    }))
  } catch (stateError) {
    console.error(
      `Gif-Guardian could not record AutoModerator sync error; ${formatError(
        stateError,
      )}`,
    )
  }
}

async function buildPendingResult(activeCount: number): Promise<SyncResult> {
  const state = await getRegistryState()
  return {
    status: 'pending',
    revision: state.desiredRevision,
    activeCount,
    wikiRevisionId: state.wikiRevisionId,
  }
}

export async function syncAutoMod(subredditName: string): Promise<SyncResult> {
  const lockToken = await acquireLock()
  const renewal = setInterval(() => {
    void renewLock(lockToken).catch(error => console.error(formatError(error)))
  }, LOCK_RENEW_INTERVAL_MS)
  let revision: number | undefined
  let activeCount = 0

  try {
    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      await assertLockOwned(lockToken)
      const initialState = await getRegistryState()
      revision = initialState.desiredRevision
      const active = (await listRestrictedGifs()).filter(
        gif => gif.status === 'active',
      )
      activeCount = active.length
      const initialPage = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)
      const block = buildManagedBlock(active)
      const pageBeforeWrite = await reddit.getWikiPage(
        subredditName,
        AUTOMOD_PAGE,
      )

      if (
        pageBeforeWrite.revisionId !== initialPage.revisionId ||
        (await getRegistryState()).desiredRevision !== revision
      ) {
        if (attempt === MAX_SYNC_ATTEMPTS)
          return buildPendingResult(activeCount)
        continue
      }

      const updatedContent = ensureManagedBlock(pageBeforeWrite.content, block)
      await assertLockOwned(lockToken)

      if (updatedContent !== pageBeforeWrite.content) {
        await reddit.updateWikiPage({
          subredditName,
          page: AUTOMOD_PAGE,
          content: updatedContent,
          reason: 'Gif-Guardian AutoModerator sync',
        })
      }

      const latestPage = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)
      if (
        ensureManagedBlock(latestPage.content, block) !== latestPage.content
      ) {
        if (attempt === MAX_SYNC_ATTEMPTS)
          return buildPendingResult(activeCount)
        continue
      }

      const committedState = await markSyncSuccess(
        revision,
        latestPage.revisionId,
      )
      if (committedState.desiredRevision !== revision) {
        return buildPendingResult(activeCount)
      }
      return {
        status: 'synced',
        revision,
        activeCount,
        wikiRevisionId: latestPage.revisionId,
      }
    }
    return buildPendingResult(activeCount)
  } catch (error) {
    if (revision !== undefined && !(error instanceof AutoModLeaseLostError)) {
      await markSyncError(revision, error)
    }
    if (error instanceof AutoModLeaseLostError) {
      return buildPendingResult(activeCount)
    }
    throw error
  } finally {
    clearInterval(renewal)
    await releaseLock(lockToken)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
