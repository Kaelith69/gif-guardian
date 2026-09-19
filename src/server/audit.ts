import {redis} from '@devvit/web/server'

const AUDIT_KEY = 'gif-guardian:audit'
const AUDIT_SEQUENCE_KEY = 'gif-guardian:audit:sequence'

export type AuditAction =
  | 'restrict'
  | 'disable'
  | 'restore'
  | 'initialize-automod'

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
}

export async function listAudit(
  limit = 100,
): Promise<Array<AuditRecord & {id: number}>> {
  const total = await redis.zCard(AUDIT_KEY)

  if (total === 0) {
    return []
  }

  const start = Math.max(0, total - limit)
  const entries = await redis.zRange(AUDIT_KEY, start, total - 1, {
    by: 'rank',
  })

  return entries.reverse().map(entry => JSON.parse(entry.member))
}
