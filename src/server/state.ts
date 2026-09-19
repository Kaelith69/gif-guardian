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

const MAX_STATE_TRANSACTION_RETRIES = 5

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
  const parsed = parseJsonRecord<Partial<RegistryState>>(
    value,
    'state',
  )

  if (
    typeof parsed.desiredRevision !== 'number' ||
    !Number.isSafeInteger(parsed.desiredRevision) ||
    parsed.desiredRevision < 0 ||
    typeof parsed.syncedRevision !== 'number' ||
    !Number.isSafeInteger(parsed.syncedRevision) ||
    parsed.syncedRevision < 0 ||
    parsed.syncedRevision > parsed.desiredRevision ||
    !['synced', 'pending', 'error'].includes(
      parsed.syncStatus ?? '',
    ) ||
    (parsed.lastSyncAt !== null &&
      typeof parsed.lastSyncAt !== 'string') ||
    (parsed.lastSyncError !== null &&
      typeof parsed.lastSyncError !== 'string') ||
    (parsed.wikiRevisionId !== null &&
      typeof parsed.wikiRevisionId !== 'string')
  ) {
    throw new Error(
      'Invalid Gif-Guardian registry state.',
    )
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

export async function saveRegistryState(
  state: RegistryState,
): Promise<void> {
  validateRegistryState(state)

  await redis.set(
    STATE_KEY,
    JSON.stringify(state),
  )
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
    throw new Error(
      'Invalid Gif-Guardian registry revision state.',
    )
  }

  if (
    previous &&
    (state.desiredRevision < previous.desiredRevision ||
      state.syncedRevision < previous.syncedRevision)
  ) {
    throw new Error(
      'Gif-Guardian registry revisions cannot move backwards.',
    )
  }

  if (
    state.lastSyncAt !== null &&
    typeof state.lastSyncAt !== 'string'
  ) {
    throw new Error(
      'Invalid Gif-Guardian last-sync timestamp.',
    )
  }

  if (
    state.lastSyncError !== null &&
    typeof state.lastSyncError !== 'string'
  ) {
    throw new Error(
      'Invalid Gif-Guardian sync error.',
    )
  }

  if (
    state.wikiRevisionId !== null &&
    typeof state.wikiRevisionId !== 'string'
  ) {
    throw new Error(
      'Invalid Gif-Guardian wiki revision ID.',
    )
  }
}

export async function updateRegistryState(
  expectedRevision: number,
  update: (state: RegistryState) => RegistryState,
): Promise<RegistryState> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Invalid Gif-Guardian expected registry revision.')
  }

  for (
    let attempt = 0;
    attempt < MAX_STATE_TRANSACTION_RETRIES;
    attempt += 1
  ) {
    const transaction = await redis.watch(STATE_KEY)
    const value = await transaction.get(STATE_KEY)

    const current = value
      ? parseRegistryState(value)
      : EMPTY_STATE

    if (current.desiredRevision !== expectedRevision) {
      await transaction.discard()
      return current
    }

    const next = update(current)

    validateRegistryState(next, current)

    await transaction.multi()

    await transaction.set(
      STATE_KEY,
      JSON.stringify(next),
    )

    const result = await transaction.exec()

    if (result) {
      return next
    }
  }

  throw new Error(
    'Gif-Guardian state changed concurrently; please retry.',
  )
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
      expiration: new Date(
        Date.now() + ACTION_TTL_SECONDS * 1000,
      ),
    },
  )

  return response === 'OK'
}

export async function getActionResult(
  commentId: string,
): Promise<ActionResult | undefined> {
  const value = await redis.get(actionKey(commentId))

  return value
    ? parseJsonRecord<ActionResult>(
        value,
        'action result',
      )
    : undefined
}

export async function saveActionResult(
  commentId: string,
  result: ActionResult,
): Promise<void> {
  await redis.set(
    actionKey(commentId),
    JSON.stringify(result),
    {
      expiration: new Date(
        Date.now() + ACTION_TTL_SECONDS * 1000,
      ),
    },
  )
}