import {reddit, redis} from '@devvit/web/server'

import {listRestrictedGifs} from './gif-store.ts'
import {
  AUTOMOD_LOCK_KEY,
  getRegistryState,
  LOCK_TTL_SECONDS,
  MAX_AUTOMOD_RULE_BYTES,
  updateRegistryState,
} from './state.ts'

const AUTOMOD_PAGE = 'config/automoderator'

const START_MARKER = '# === COCONAAD GIF GUARD START ==='
const END_MARKER = '# === COCONAAD GIF GUARD END ==='

const MAX_SYNC_ATTEMPTS = 3

export type SyncResult = {
  status: 'synced' | 'pending'
  revision: number
  activeCount: number
  wikiRevisionId: string | null
}

export function buildRule(ids: string[]): string {
  const escapedIds = ids.map(id =>
    id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )

  const regex =
    `!\\[gif\\]\\(giphy\\|(${escapedIds.join('|')})(?:\\|[^)]*)?\\)`

  return [
    'type: comment',
    `body (includes, regex): '${regex}'`,
    'action: spam',
    'action_reason: "pookie_cm"',
    'moderators_exempt: false',
  ].join('\n')
}

export function packIds(ids: string[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []

  for (const id of ids) {
    const candidate = [...current, id]
    const rule = buildRule(candidate)
    const size = Buffer.byteLength(rule, 'utf8')

    if (
      current.length > 0 &&
      size > MAX_AUTOMOD_RULE_BYTES
    ) {
      groups.push(current)
      current = [id]
    } else {
      current = candidate
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }

  return groups
}

export function buildManagedBlock(
  activeIds: string[],
): string {
  const rules = packIds(activeIds)

  const body = rules.length
    ? rules.map(buildRule).join('\n')
    : '# Gif-Guardian: no active GIF restrictions.'

  return [
    START_MARKER,
    body,
    END_MARKER,
  ].join('\n')
}

export function ensureManagedBlock(
  content: string,
  block: string,
): string {
  const starts = findAllOccurrences(
    content,
    START_MARKER,
  )
  const ends = findAllOccurrences(
    content,
    END_MARKER,
  )

  if (starts.length === 0 && ends.length === 0) {
    if (content.length === 0) {
      return `${block}\n`
    }

    const separator = content.endsWith('\n')
      ? '\n'
      : '\n\n'

    return `${content}${separator}${block}\n`
  }

  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(
      'Gif-Guardian AutoModerator contains duplicate or incomplete markers.',
    )
  }

  const start = starts[0]!
  const end = ends[0]!

  if (end < start) {
    throw new Error(
      'Gif-Guardian AutoModerator markers are in the wrong order.',
    )
  }

  return (
    content.slice(0, start) +
    block +
    content.slice(end + END_MARKER.length)
  )
}

function findAllOccurrences(
  content: string,
  marker: string,
): number[] {
  const positions: number[] = []
  let offset = 0

  while (true) {
    const index = content.indexOf(
      marker,
      offset,
    )

    if (index === -1) {
      return positions
    }

    positions.push(index)
    offset = index + marker.length
  }
}

class AutoModLeaseLostError extends Error {
  constructor() {
    super('Gif-Guardian AutoModerator sync lock was lost.')
    this.name = 'AutoModLeaseLostError'
  }
}

async function acquireLock(): Promise<string> {
  const token = crypto.randomUUID()

  const result = await redis.set(
    AUTOMOD_LOCK_KEY,
    token,
    {
      nx: true,
      expiration: new Date(
        Date.now() + LOCK_TTL_SECONDS * 1_000,
      ),
    },
  )

  if (result !== 'OK') {
    throw new Error(
      'Gif-Guardian AutoModerator sync is already in progress.',
    )
  }

  return token
}

async function assertLockOwned(
  token: string,
): Promise<void> {
  const currentToken = await redis.get(
    AUTOMOD_LOCK_KEY,
  )

  if (currentToken !== token) {
    throw new AutoModLeaseLostError()
  }
}

async function releaseLock(token: string): Promise<void> {
  const currentToken = await redis.get(AUTOMOD_LOCK_KEY)

  if (currentToken === token) {
    await redis.del(AUTOMOD_LOCK_KEY)
  }
}

async function assertLease(token: string): Promise<void> {
  await assertLockOwned(token)
}

async function markSyncSuccess(
  revision: number,
  wikiRevisionId: string,
) {
  return updateRegistryState(
    revision,
    current => ({
      ...current,
      syncedRevision: revision,
      syncStatus: 'synced',
      lastSyncAt: new Date().toISOString(),
      lastSyncError: null,
      wikiRevisionId,
    }),
  )
}

async function markSyncPending(
  revision: number,
) {
  return updateRegistryState(
    revision,
    current => ({
      ...current,
      syncStatus: 'pending',
      lastSyncError: null,
    }),
  )
}

async function markSyncError(
  revision: number,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : String(error)

  try {
    await updateRegistryState(
      revision,
      current => ({
        ...current,
        syncStatus: 'error',
        lastSyncError: message,
      }),
    )
  } catch (stateError) {
    console.error(
      `Gif-Guardian could not record AutoModerator sync error; ${formatError(
        stateError,
      )}`,
    )
  }
}

async function buildPendingResult(
  activeCount: number,
): Promise<SyncResult> {
  const state = await getRegistryState()

  return {
    status: 'pending',
    revision: state.desiredRevision,
    activeCount,
    wikiRevisionId: state.wikiRevisionId,
  }
}

export async function syncAutoMod(
  subredditName: string,
): Promise<SyncResult> {
  const lockToken = await acquireLock()

  let currentRevision: number | undefined
  let lastActiveCount = 0

  try {
    for (
      let attempt = 1;
      attempt <= MAX_SYNC_ATTEMPTS;
      attempt += 1
    ) {
      await assertLease(lockToken)

      const initialState =
        await getRegistryState()

      currentRevision =
        initialState.desiredRevision

      const activeIds = (
        await listRestrictedGifs()
      )
        .filter(
          gif => gif.status === 'active',
        )
        .map(gif => gif.giphyId)
        .sort()

      lastActiveCount = activeIds.length

      await assertLease(lockToken)

      const stateAfterRegistryRead =
        await getRegistryState()

      if (
        stateAfterRegistryRead.desiredRevision !==
        currentRevision
      ) {
        if (
          attempt === MAX_SYNC_ATTEMPTS
        ) {
          return buildPendingResult(
            lastActiveCount,
          )
        }

        continue
      }

      const initialPage =
        await reddit.getWikiPage(
          subredditName,
          AUTOMOD_PAGE,
        )

      const block =
        buildManagedBlock(activeIds)

      await assertLease(lockToken)

      const stateBeforeWrite =
        await getRegistryState()

      if (
        stateBeforeWrite.desiredRevision !==
        currentRevision
      ) {
        if (
          attempt === MAX_SYNC_ATTEMPTS
        ) {
          return buildPendingResult(
            lastActiveCount,
          )
        }

        continue
      }

      /*
       * Re-read the wiki immediately before writing.
       * This avoids applying a block calculated from an older wiki
       * revision when another moderator changed the page meanwhile.
       */
      const pageBeforeWrite =
        await reddit.getWikiPage(
          subredditName,
          AUTOMOD_PAGE,
        )

      if (
        pageBeforeWrite.revisionId !==
        initialPage.revisionId
      ) {
        if (
          attempt === MAX_SYNC_ATTEMPTS
        ) {
          await markSyncPending(
            currentRevision,
          )

          return buildPendingResult(
            lastActiveCount,
          )
        }

        continue
      }

      const updatedContent =
        ensureManagedBlock(
          pageBeforeWrite.content,
          block,
        )

      await assertLease(lockToken)

      const latestStateBeforeWrite =
        await getRegistryState()

      if (
        latestStateBeforeWrite.desiredRevision !==
        currentRevision
      ) {
        if (
          attempt === MAX_SYNC_ATTEMPTS
        ) {
          return buildPendingResult(
            lastActiveCount,
          )
        }

        continue
      }

      if (
        updatedContent !==
        pageBeforeWrite.content
      ) {
        await reddit.updateWikiPage({
          subredditName,
          page: AUTOMOD_PAGE,
          content: updatedContent,
          reason:
            'Gif-Guardian AutoModerator sync',
        })
      }

      await assertLease(lockToken)

      const latestPage =
        await reddit.getWikiPage(
          subredditName,
          AUTOMOD_PAGE,
        )

      const afterWriteState =
        await getRegistryState()

      if (
        afterWriteState.desiredRevision !==
        currentRevision
      ) {
        if (
          attempt === MAX_SYNC_ATTEMPTS
        ) {
          return buildPendingResult(
            lastActiveCount,
          )
        }

        continue
      }

      const verifiedContent =
        ensureManagedBlock(
          latestPage.content,
          block,
        )

      if (
        verifiedContent !==
        latestPage.content
      ) {
        if (
          attempt === MAX_SYNC_ATTEMPTS
        ) {
          await markSyncPending(
            currentRevision,
          )

          return buildPendingResult(
            lastActiveCount,
          )
        }

        continue
      }

      await assertLease(lockToken)

      const committedState =
        await markSyncSuccess(
          currentRevision,
          latestPage.revisionId,
        )

      if (
        committedState.desiredRevision !==
          currentRevision ||
        committedState.syncedRevision !==
          currentRevision
      ) {
        return {
          status: 'pending',
          revision:
            committedState.desiredRevision,
          activeCount: lastActiveCount,
          wikiRevisionId:
            committedState.wikiRevisionId,
        }
      }

      return {
        status: 'synced',
        revision: currentRevision,
        activeCount: lastActiveCount,
        wikiRevisionId:
          latestPage.revisionId,
      }
    }

    return buildPendingResult(
      lastActiveCount,
    )
  } catch (error) {
    if (
      error instanceof AutoModLeaseLostError
    ) {
      return buildPendingResult(
        lastActiveCount,
      )
    }

    if (currentRevision !== undefined) {
      await markSyncError(
        currentRevision,
        error,
      )
    }

    throw error
  } finally {
    try {
      await releaseLock(lockToken)
    } catch (error) {
      console.error(
        `Gif-Guardian could not safely release the AutoModerator sync lock; ${formatError(
          error,
        )}`,
      )
    }
  }
}

function formatError(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error)
}