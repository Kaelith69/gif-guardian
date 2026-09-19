import {redis} from '@devvit/web/server'
import type {GifStatus, RestrictedGif} from './gif.ts'
import {
  GIF_HASH_KEY,
  getRegistryState,
  type RegistryState,
  SOURCE_COMMENTS_KEY,
  SOURCE_POSTS_KEY,
  STATE_KEY,
} from './state.ts'
import {parseRestrictedGif} from './validation.ts'

const MAX_TRANSACTION_RETRIES = 5

export type RegistryMutation = {
  records: RestrictedGif[]
  changed: boolean
  alreadyRestricted: string[]
  revision: number
}

function serializeSourceIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)].sort())
}

async function getSourceIds(
  sourceId: string,
  sourceType: 'comment' | 'post' = 'comment',
): Promise<string[]> {
  const value = await redis.hGet(
    sourceType === 'comment' ? SOURCE_COMMENTS_KEY : SOURCE_POSTS_KEY,
    sourceId,
  )

  if (!value) {
    return []
  }

  let ids: unknown

  try {
    ids = JSON.parse(value)
  } catch {
    throw new Error(`Invalid source-reference index for ${sourceId}.`)
  }

  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
    throw new Error(`Invalid source-reference index for ${sourceId}.`)
  }

  return ids
}

export async function getRestrictedGif(
  giphyId: string,
): Promise<RestrictedGif | undefined> {
  const value = await redis.hGet(GIF_HASH_KEY, giphyId)

  return value ? parseRestrictedGif(value) : undefined
}

export async function listRestrictedGifs(): Promise<RestrictedGif[]> {
  const values = await redis.hGetAll(GIF_HASH_KEY)

  return Object.values(values)
    .map(value => parseRestrictedGif(value))
    .sort((a, b) => a.giphyId.localeCompare(b.giphyId))
}

export async function mutateRestrictions(
  incoming: Array<{
    giphyId: string
    reason: string
    username?: string
    sourceComment: string
    sourceUrl: string
    sourcePost: string
  }>,
  status: GifStatus = 'active',
): Promise<RegistryMutation> {
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
    const transaction = await redis.watch(
      GIF_HASH_KEY,
      SOURCE_COMMENTS_KEY,
      SOURCE_POSTS_KEY,
      STATE_KEY,
    )
    const existing = new Map<string, RestrictedGif>()

    for (const item of incoming) {
      const record = await getRestrictedGif(item.giphyId)

      if (record) {
        existing.set(item.giphyId, record)
      }
    }

    const currentState = await getRegistryState()
    const now = new Date().toISOString()
    const alreadyRestricted: string[] = []
    const records: RestrictedGif[] = []

    for (const item of incoming) {
      const previous = existing.get(item.giphyId)

      if (previous?.status === 'active' && status === 'active') {
        alreadyRestricted.push(item.giphyId)
        records.push(previous)
        continue
      }

      records.push({
        giphyId: item.giphyId,
        status,
        reason: previous?.reason ?? item.reason,
        firstAddedAt: previous?.firstAddedAt ?? now,
        firstAddedBy: previous?.firstAddedBy ?? item.username,
        lastActionAt: now,
        lastActionBy: item.username,
        sourceComment: previous?.sourceComment ?? item.sourceComment,
        sourceUrl: previous?.sourceUrl ?? item.sourceUrl,
        sourcePost: previous?.sourcePost ?? item.sourcePost,
      })
    }

    const changed = records.some(record => {
      const previous = existing.get(record.giphyId)

      return JSON.stringify(previous) !== JSON.stringify(record)
    })

    if (!changed) {
      await transaction.discard()
      return {
        records,
        changed: false,
        alreadyRestricted,
        revision: currentState.desiredRevision,
      }
    }

    const nextState: RegistryState = {
      ...currentState,
      desiredRevision: currentState.desiredRevision + 1,
      syncStatus: 'pending',
      lastSyncError: null,
    }

    await transaction.multi()
    await transaction.hSet(
      GIF_HASH_KEY,
      Object.fromEntries(
        records.map(record => [record.giphyId, JSON.stringify(record)]),
      ),
    )

    for (const record of records) {
      const sourceIds = await getSourceIds(record.sourceComment)

      await transaction.hSet(SOURCE_COMMENTS_KEY, {
        [record.sourceComment]: serializeSourceIds([
          ...sourceIds,
          record.giphyId,
        ]),
      })

      const postIds = await getSourceIds(record.sourcePost, 'post')

      await transaction.hSet(SOURCE_POSTS_KEY, {
        [record.sourcePost]: serializeSourceIds([...postIds, record.giphyId]),
      })
    }

    await transaction.set(STATE_KEY, JSON.stringify(nextState))
    const result = await transaction.exec()

    if (result) {
      return {
        records,
        changed: true,
        alreadyRestricted,
        revision: nextState.desiredRevision,
      }
    }
  }

  throw new Error('Gif-Guardian registry changed concurrently; please retry.')
}

export async function setGifStatus(
  giphyId: string,
  status: GifStatus,
  username?: string,
): Promise<RestrictedGif | undefined> {
  const existing = await getRestrictedGif(giphyId)

  if (!existing) {
    return undefined
  }

  const mutation = await mutateRestrictions(
    [
      {
        giphyId,
        reason: existing.reason,
        username,
        sourceComment: existing.sourceComment,
        sourceUrl: existing.sourceUrl,
        sourcePost: existing.sourcePost,
      },
    ],
    status,
  )

  return mutation.records[0]
}

export async function markSyncPending(): Promise<RegistryState> {
  const state = await getRegistryState()
  const next = {...state, syncStatus: 'pending' as const, lastSyncError: null}

  await redis.set(STATE_KEY, JSON.stringify(next))
  return next
}

export async function removeSourceReference(
  sourceId: string,
  sourceType: 'comment' | 'post',
): Promise<void> {
  await redis.hDel(
    sourceType === 'comment' ? SOURCE_COMMENTS_KEY : SOURCE_POSTS_KEY,
    [sourceId],
  )
}

export async function getSourceReference(
  sourceId: string,
  sourceType: 'comment' | 'post',
): Promise<string[]> {
  return getSourceIds(sourceId, sourceType)
}
