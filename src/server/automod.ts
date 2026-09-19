import {reddit, redis} from '@devvit/web/server'
import {listRestrictedGifs} from './gif-store.ts'
import {
  AUTOMOD_LOCK_KEY,
  getRegistryState,
  LOCK_TTL_SECONDS,
  MAX_AUTOMOD_RULE_BYTES,
  type RegistryState,
  updateRegistryState,
} from './state.ts'

const AUTOMOD_PAGE = 'config/automoderator'
const START_MARKER = '# === COCONAAD GIF GUARD START ==='
const END_MARKER = '# === COCONAAD GIF GUARD END ==='

export function buildRule(ids: string[]): string {
  const escapedIds = ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = `!\\[gif\\]\\(giphy\\|(${escapedIds.join('|')})(?:\\|[^)]*)?\\)`

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

    if (current.length > 0 && size > MAX_AUTOMOD_RULE_BYTES) {
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

export function buildManagedBlock(activeIds: string[]): string {
  const rules = packIds(activeIds)
  const body = rules.length
    ? rules.map(buildRule).join('\n')
    : '# Gif-Guardian: no active GIF restrictions.'

  return [START_MARKER, body, END_MARKER].join('\n')
}

export function ensureManagedBlock(content: string, block: string): string {
  const start = content.indexOf(START_MARKER)
  const end = content.indexOf(END_MARKER)

  if ((start === -1) !== (end === -1)) {
    throw new Error('Gif-Guardian AutoModerator markers are incomplete.')
  }

  if (start !== -1 && end !== -1 && end >= start) {
    return (
      content.slice(0, start) + block + content.slice(end + END_MARKER.length)
    )
  }

  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n'
  return `${content}${separator}\n${block}\n`
}

async function acquireLock(): Promise<string> {
  const token = crypto.randomUUID()
  const result = await redis.set(AUTOMOD_LOCK_KEY, token, {
    nx: true,
    expiration: new Date(Date.now() + LOCK_TTL_SECONDS * 1000),
  })

  if (result !== 'OK') {
    throw new Error('Gif-Guardian AutoModerator sync is already in progress.')
  }

  return token
}

async function releaseLock(token: string): Promise<void> {
  if ((await redis.get(AUTOMOD_LOCK_KEY)) === token) {
    await redis.del(AUTOMOD_LOCK_KEY)
  }
}

async function markSyncSuccess(
  revision: number,
  wikiRevisionId: string,
): Promise<RegistryState> {
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
  const message = error instanceof Error ? error.message : String(error)

  await updateRegistryState(revision, current => ({
    ...current,
    syncStatus: 'error',
    lastSyncError: message,
  }))
}

export async function getAutoModStatus(subredditName: string): Promise<{
  pageExists: boolean
  managedBlockPresent: boolean
  state: RegistryState
}> {
  const state = await getRegistryState()

  try {
    const page = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)

    return {
      pageExists: true,
      managedBlockPresent:
        page.content.includes(START_MARKER) &&
        page.content.includes(END_MARKER),
      state,
    }
  } catch {
    return {pageExists: false, managedBlockPresent: false, state}
  }
}

export async function syncAutoMod(subredditName: string): Promise<number> {
  const lockToken = await acquireLock()
  const revision = (await getRegistryState()).desiredRevision

  try {
    const page = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)
    const activeIds = (await listRestrictedGifs())
      .filter(gif => gif.status === 'active')
      .map(gif => gif.giphyId)
      .sort()
    const block = buildManagedBlock(activeIds)
    const updatedContent = ensureManagedBlock(page.content, block)

    if ((await redis.get(AUTOMOD_LOCK_KEY)) !== lockToken) {
      throw new Error('Gif-Guardian AutoModerator sync lock expired.')
    }

    if (updatedContent !== page.content) {
      await reddit.updateWikiPage({
        subredditName,
        page: AUTOMOD_PAGE,
        content: updatedContent,
        reason: 'Gif-Guardian AutoModerator sync',
      })
    }

    const latestPage = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)
    await markSyncSuccess(revision, latestPage.revisionId)
    return activeIds.length
  } catch (error) {
    await markSyncError(revision, error)
    throw error
  } finally {
    await releaseLock(lockToken)
  }
}

export async function initializeAutoMod(subredditName: string): Promise<void> {
  await syncAutoMod(subredditName)
}
