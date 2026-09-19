import {redis} from '@devvit/web/server'
import {parseJsonRecord} from './validation.ts'

export const GIF_HASH_KEY = 'gif-guardian:restricted-gifs'
export const STATE_KEY = 'gif-guardian:state'
export const SOURCE_COMMENTS_KEY = 'gif-guardian:source-comments'
export const SOURCE_POSTS_KEY = 'gif-guardian:source-posts'
export const AUTOMOD_LOCK_KEY = 'gif-guardian:automod-lock'
export const AUDIT_KEY = 'gif-guardian:audit'
export const AUDIT_SEQUENCE_KEY = 'gif-guardian:audit:sequence'
export const ACTION_KEY_PREFIX = 'gif-guardian:action:'

export const AUDIT_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const ACTION_TTL_SECONDS = 10 * 60
export const LOCK_TTL_SECONDS = 120
export const MAX_AUTOMOD_RULE_BYTES = 8_000

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

export async function getRegistryState(): Promise<RegistryState> {
  const value = await redis.get(STATE_KEY)

  if (!value) {
    return EMPTY_STATE
  }

  const parsed = parseJsonRecord<Partial<RegistryState>>(value, 'state')

  if (
    typeof parsed.desiredRevision !== 'number' ||
    typeof parsed.syncedRevision !== 'number' ||
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

export async function saveRegistryState(state: RegistryState): Promise<void> {
  await redis.set(STATE_KEY, JSON.stringify(state))
}

export async function updateRegistryState(
  expectedRevision: number,
  update: (state: RegistryState) => RegistryState,
): Promise<RegistryState> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const transaction = await redis.watch(STATE_KEY)
    const current = await getRegistryState()

    if (current.desiredRevision !== expectedRevision) {
      await transaction.discard()
      return current
    }

    const next = update(current)
    await transaction.multi()
    await transaction.set(STATE_KEY, JSON.stringify(next))

    if (await transaction.exec()) {
      return next
    }
  }

  throw new Error('Gif-Guardian state changed concurrently; please retry.')
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
