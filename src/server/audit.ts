import {redis} from '@devvit/redis'
import {
  AUDIT_KEY,
  AUDIT_RETENTION_SECONDS,
  AUDIT_SEQUENCE_KEY,
} from './state.ts'

export type AuditAction =
  | 'restrict'
  | 'already-restricted'
  | 'disable'
  | 'restore'
  | 'sync'
  | 'sync-error'

export type AuditStatus = 'success' | 'partial' | 'failed'

export type AuditRecord = {
  action: AuditAction
  status: AuditStatus
  giphyIds?: string[]
  commentId?: string
  postId?: string
  moderator: string
  at: string
  reason?: string
  removedComment?: boolean
  note?: string
}

const AUDIT_ACTIONS: AuditAction[] = [
  'restrict',
  'already-restricted',
  'disable',
  'restore',
  'sync',
  'sync-error',
]

const AUDIT_STATUSES: AuditStatus[] = ['success', 'partial', 'failed']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseAuditRecord(value: string): AuditRecord & {id: number} {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid Gif-Guardian audit JSON.')
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid Gif-Guardian audit record.')
  }

  if (
    typeof parsed.id !== 'number' ||
    !Number.isSafeInteger(parsed.id) ||
    parsed.id <= 0 ||
    !AUDIT_ACTIONS.includes(parsed.action as AuditAction) ||
    !AUDIT_STATUSES.includes(parsed.status as AuditStatus) ||
    typeof parsed.moderator !== 'string' ||
    parsed.moderator.trim() === '' ||
    typeof parsed.at !== 'string' ||
    !Number.isFinite(Date.parse(parsed.at))
  ) {
    throw new Error('Invalid Gif-Guardian audit record.')
  }

  if (
    (parsed.giphyIds !== undefined &&
      (!Array.isArray(parsed.giphyIds) ||
        !parsed.giphyIds.every(id => typeof id === 'string'))) ||
    (parsed.removedComment !== undefined &&
      typeof parsed.removedComment !== 'boolean') ||
    (parsed.reason !== undefined && typeof parsed.reason !== 'string') ||
    (parsed.note !== undefined && typeof parsed.note !== 'string') ||
    (parsed.commentId !== undefined && typeof parsed.commentId !== 'string') ||
    (parsed.postId !== undefined && typeof parsed.postId !== 'string')
  ) {
    throw new Error('Invalid Gif-Guardian audit record.')
  }

  return parsed as AuditRecord & {id: number}
}

export async function appendAudit(record: AuditRecord): Promise<void> {
  const sequence = await redis.incrBy(AUDIT_SEQUENCE_KEY, 1)

  const member = JSON.stringify({
    id: sequence,
    ...record,
  })

  await redis.zAdd(AUDIT_KEY, {
    member,
    score: Date.parse(record.at),
  })

  await redis.zRemRangeByScore(
    AUDIT_KEY,
    Number.NEGATIVE_INFINITY,
    Date.now() - AUDIT_RETENTION_SECONDS * 1000,
  )
}

export async function listAudit(
  limit = 100,
): Promise<Array<AuditRecord & {id: number}>> {
  const safeLimit = Math.min(1_000, Math.max(0, Math.trunc(limit)))

  if (safeLimit === 0) {
    return []
  }

  const total = await redis.zCard(AUDIT_KEY)

  if (total === 0) {
    return []
  }

  const start = Math.max(0, total - safeLimit)
  const entries = await redis.zRange(AUDIT_KEY, start, total - 1, {
    by: 'rank',
  })

  return entries
    .flatMap(entry => {
      try {
        return [parseAuditRecord(entry.member)]
      } catch (error) {
        console.error(
          `Gif-Guardian skipped a malformed audit record; ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        return []
      }
    })
    .sort((a, b) => b.id - a.id)
}
