import {redis} from '@devvit/redis'
import type {GifStatus, RestrictedGif} from './gif.ts'
import {
  EMPTY_STATE,
  GIF_HASH_KEY,
  getRegistryState,
  parseRegistryState,
  type RegistryState,
  SOURCE_COMMENTS_KEY,
  SOURCE_POSTS_KEY,
  STATE_KEY,
  withRegistryLock,
} from './state.ts'
import {parseRestrictedGif} from './validation.ts'

const MAX_TRANSACTION_RETRIES = 5

export type RegistryMutation = {
  records: RestrictedGif[]
  changed: boolean
  alreadyRestricted: string[]
  revision: number
}

type RestrictionInput = {
  giphyId: string
  reason: string
  username?: string
  sourceComment: string
  sourceUrl: string
  sourcePost: string
}

type SourceType = 'comment' | 'post'

function getSourceKey(sourceType: SourceType): string {
  return sourceType === 'comment' ? SOURCE_COMMENTS_KEY : SOURCE_POSTS_KEY
}

function serializeSourceIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)].sort())
}

function parseSourceIds(value: string, sourceId: string): string[] {
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

function dedupeInputs(incoming: RestrictionInput[]): RestrictionInput[] {
  const byId = new Map<string, RestrictionInput>()

  for (const item of incoming) {
    byId.set(item.giphyId, item)
  }

  return [...byId.values()]
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
  incoming: RestrictionInput[],
  status: GifStatus = 'active',
): Promise<RegistryMutation> {
  const items = dedupeInputs(incoming)

  if (items.length === 0) {
    const state = await getRegistryState()

    return {
      records: [],
      changed: false,
      alreadyRestricted: [],
      revision: state.desiredRevision,
    }
  }

  return withRegistryLock(async () => {
    for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
      const existing = new Map<string, RestrictedGif>()

      for (const item of items) {
        const value = await redis.hGet(GIF_HASH_KEY, item.giphyId)

        if (value) {
          existing.set(item.giphyId, parseRestrictedGif(value))
        }
      }

      const stateValue = await redis.get(STATE_KEY)
      const currentState = stateValue
        ? parseRegistryState(stateValue)
        : EMPTY_STATE

      const now = new Date().toISOString()
      const alreadyRestricted: string[] = []
      const records: RestrictedGif[] = []

      for (const item of items) {
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
        return {
          records,
          changed: false,
          alreadyRestricted,
          revision: currentState.desiredRevision,
        }
      }

      const affectedComments = new Set<string>()
      const affectedPosts = new Set<string>()

      for (const record of records) {
        affectedComments.add(record.sourceComment)
        affectedPosts.add(record.sourcePost)
      }

      const commentIndexes = new Map<string, string[]>()
      const postIndexes = new Map<string, string[]>()

      for (const sourceId of affectedComments) {
        const value = await redis.hGet(SOURCE_COMMENTS_KEY, sourceId)

        commentIndexes.set(
          sourceId,
          value ? parseSourceIds(value, sourceId) : [],
        )
      }

      for (const sourceId of affectedPosts) {
        const value = await redis.hGet(SOURCE_POSTS_KEY, sourceId)

        postIndexes.set(sourceId, value ? parseSourceIds(value, sourceId) : [])
      }

      for (const record of records) {
        const commentIds = commentIndexes.get(record.sourceComment) ?? []

        commentIndexes.set(record.sourceComment, [
          ...commentIds,
          record.giphyId,
        ])

        const postIds = postIndexes.get(record.sourcePost) ?? []

        postIndexes.set(record.sourcePost, [...postIds, record.giphyId])
      }

      const nextState: RegistryState = {
        ...currentState,
        desiredRevision: currentState.desiredRevision + 1,
        syncStatus: 'pending',
        lastSyncError: null,
      }

      const transaction = await redis.watch(
        GIF_HASH_KEY,
        SOURCE_COMMENTS_KEY,
        SOURCE_POSTS_KEY,
        STATE_KEY,
      )

      await transaction.multi()

      await transaction.hSet(
        GIF_HASH_KEY,
        Object.fromEntries(
          records.map(record => [record.giphyId, JSON.stringify(record)]),
        ),
      )

      for (const [sourceId, ids] of commentIndexes) {
        await transaction.hSet(SOURCE_COMMENTS_KEY, {
          [sourceId]: serializeSourceIds(ids),
        })
      }

      for (const [sourceId, ids] of postIndexes) {
        await transaction.hSet(SOURCE_POSTS_KEY, {
          [sourceId]: serializeSourceIds(ids),
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
  })
}

export async function setGifStatus(
  giphyId: string,
  status: GifStatus,
  username?: string,
): Promise<RestrictedGif | undefined> {
  return withRegistryLock(async () => {
    for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
      const value = await redis.hGet(GIF_HASH_KEY, giphyId)

      if (!value) {
        return undefined
      }

      const existing = parseRestrictedGif(value)

      if (existing.status === status) {
        return existing
      }

      const stateValue = await redis.get(STATE_KEY)
      const currentState = stateValue
        ? parseRegistryState(stateValue)
        : EMPTY_STATE

      const updated: RestrictedGif = {
        ...existing,
        status,
        lastActionAt: new Date().toISOString(),
        lastActionBy: username,
      }

      const nextState: RegistryState = {
        ...currentState,
        desiredRevision: currentState.desiredRevision + 1,
        syncStatus: 'pending',
        lastSyncError: null,
      }

      const transaction = await redis.watch(GIF_HASH_KEY, STATE_KEY)

      await transaction.multi()

      await transaction.hSet(GIF_HASH_KEY, {
        [giphyId]: JSON.stringify(updated),
      })

      await transaction.set(STATE_KEY, JSON.stringify(nextState))

      const result = await transaction.exec()

      if (result) {
        return updated
      }
    }

    throw new Error('Gif-Guardian registry changed concurrently; please retry.')
  })
}

export async function removeSourceReference(
  sourceId: string,
  sourceType: SourceType,
): Promise<void> {
  const sourceKey = getSourceKey(sourceType)

  await withRegistryLock(async () => {
    await redis.hDel(sourceKey, [sourceId])
  })
}
