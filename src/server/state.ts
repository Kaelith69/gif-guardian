import {redis} from '@devvit/redis'
import {parseJsonRecord} from './validation.ts'

export const GIF_HASH_KEY = 'gif-guardian:restricted-gifs'
export const STATE_KEY = 'gif-guardian:state'
export const SOURCE_COMMENTS_KEY = 'gif-guardian:source-comments'
export const SOURCE_POSTS_KEY = 'gif-guardian:source-posts'
export const AUTOMOD_LOCK_KEY = 'gif-guardian:automod-lock'
export const REGISTRY_LOCK_KEY = 'gif-guardian:registry-lock'
export const AUDIT_KEY = 'gif-guardian:audit'
export const AUDIT_SEQUENCE_KEY = 'gif-guardian:audit:sequence'
export const ACTION_KEY_PREFIX = 'gif-guardian:action:'

export const AUDIT_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const ACTION_TTL_SECONDS = 10 * 60
export const LOCK_TTL_SECONDS = 120
export const REGISTRY_LOCK_TTL_SECONDS = 120
export const MAX_AUTOMOD_RULE_BYTES = 8_000

const MAX_LOCK_ACQUIRE_ATTEMPTS = 10
const LOCK_RETRY_DELAY_MS = 200

export type SyncStatus = 'synced' | 'pending' | 'error'

export type RegistryState = {
  desiredRevision: number
  syncedRevision: number
  syncStatus: SyncStatus
  lastSyncAt: string | null
  lastSyncError: string | null
  wikiRevisionId: string | null
}

export const EMPTY_STATE: RegistryState = {
  desiredRevision: 0,
  syncedRevision: 0,
  syncStatus: 'synced',
  lastSyncAt: null,
  lastSyncError: null,
  wikiRevisionId: null,
}

export function parseRegistryState(value: string): RegistryState {
  const parsed = parseJsonRecord<Partial<RegistryState>>(value, 'state')

  if (
    typeof parsed.desiredRevision !== 'number' ||
    !Number.isSafeInteger(parsed.desiredRevision) ||
    parsed.desiredRevision < 0 ||
    typeof parsed.syncedRevision !== 'number' ||
    !Number.isSafeInteger(parsed.syncedRevision) ||
    parsed.syncedRevision < 0 ||
    parsed.syncedRevision > parsed.desiredRevision ||
    !['synced', 'pending', 'error'].includes(parsed.syncStatus ?? '') ||
    (parsed.lastSyncAt !== null && typeof parsed.lastSyncAt !== 'string') ||
    (parsed.lastSyncError !== null &&
      typeof parsed.lastSyncError !== 'string') ||
    (parsed.wikiRevisionId !== null &&
      typeof parsed.wikiRevisionId !== 'string')
  ) {
    throw new Error('Invalid Gif-Guardian registry state.')
  }

  return parsed as RegistryState
}

export async function getRegistryState(): Promise<RegistryState> {
  const value = await redis.get(STATE_KEY)

  if (!value) {
    return EMPTY_STATE
  }

  return parseRegistryState(value)
}

function validateRegistryState(
  state: RegistryState,
  previous?: RegistryState,
): void {
  if (
    !Number.isSafeInteger(state.desiredRevision) ||
    state.desiredRevision < 0 ||
    !Number.isSafeInteger(state.syncedRevision) ||
    state.syncedRevision < 0 ||
    state.syncedRevision > state.desiredRevision
  ) {
    throw new Error('Invalid Gif-Guardian registry revision state.')
  }

  if (
    previous &&
    (state.desiredRevision < previous.desiredRevision ||
      state.syncedRevision < previous.syncedRevision)
  ) {
    throw new Error('Gif-Guardian registry revisions cannot move backwards.')
  }

  if (state.lastSyncAt !== null && typeof state.lastSyncAt !== 'string') {
    throw new Error('Invalid Gif-Guardian last-sync timestamp.')
  }

  if (state.lastSyncError !== null && typeof state.lastSyncError !== 'string') {
    throw new Error('Invalid Gif-Guardian sync error.')
  }

  if (
    state.wikiRevisionId !== null &&
    typeof state.wikiRevisionId !== 'string'
  ) {
    throw new Error('Invalid Gif-Guardian wiki revision ID.')
  }
}

export async function withRegistryLock<T>(work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID()

  for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    const acquired = await redis.set(REGISTRY_LOCK_KEY, token, {
      nx: true,
      expiration: new Date(Date.now() + REGISTRY_LOCK_TTL_SECONDS * 1_000),
    })

    if (acquired === 'OK') {
      try {
        return await work()
      } finally {
        const owner = await redis.get(REGISTRY_LOCK_KEY)

        if (owner === token) {
          await redis.del(REGISTRY_LOCK_KEY)
        }
      }
    }

    await new Promise(resolve => {
      setTimeout(resolve, LOCK_RETRY_DELAY_MS)
    })
  }

  throw new Error('Gif-Guardian registry is busy; please retry.')
}

export async function updateRegistryState(
  expectedRevision: number,
  update: (state: RegistryState) => RegistryState,
): Promise<RegistryState> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Invalid Gif-Guardian expected registry revision.')
  }

  return withRegistryLock(async () => {
    const value = await redis.get(STATE_KEY)

    const current = value ? parseRegistryState(value) : EMPTY_STATE

    if (current.desiredRevision !== expectedRevision) {
      return current
    }

    const next = update(current)
    validateRegistryState(next, current)

    await redis.set(STATE_KEY, JSON.stringify(next))

    return next
  })
}

export function actionKey(commentId: string): string {
  return `${ACTION_KEY_PREFIX}${commentId}`
}

export type ActionResult = {
  status: 'success' | 'partial'
  giphyIds: string[]
  message: string
}

export async function claimAction(
  commentId: string,
  result: ActionResult,
): Promise<boolean> {
  const response = await redis.set(
    actionKey(commentId),
    JSON.stringify(result),
    {
      nx: true,
      expiration: new Date(Date.now() + ACTION_TTL_SECONDS * 1000),
    },
  )

  return response === 'OK'
}

export async function getActionResult(
  commentId: string,
): Promise<ActionResult | undefined> {
  const value = await redis.get(actionKey(commentId))

  return value
    ? parseJsonRecord<ActionResult>(value, 'action result')
    : undefined
}

export async function saveActionResult(
  commentId: string,
  result: ActionResult,
): Promise<void> {
  await redis.set(actionKey(commentId), JSON.stringify(result), {
    expiration: new Date(Date.now() + ACTION_TTL_SECONDS * 1000),
  })
}
