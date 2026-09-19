import {reddit} from '@devvit/web/server'
import {listRestrictedGifs} from './gif-store.ts'

const AUTOMOD_PAGE = 'config/automoderator'

const START_MARKER = '# === COCONAAD GIF GUARD START ==='
const END_MARKER = '# === COCONAAD GIF GUARD END ==='

function buildManagedBlock(activeIds: string[]): string {
  if (activeIds.length === 0) {
    return [
      START_MARKER,
      '# Gif-Guardian: no active GIF restrictions.',
      END_MARKER,
    ].join('\n')
  }

  const escapedIds = activeIds.map(id =>
    id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )

  const regex = `!\\[gif\\]\\(giphy\\|(${escapedIds.join('|')})(?:\\|[^)]*)?\\)`

  return [
    START_MARKER,
    'type: comment',
    `body (includes, regex): '${regex}'`,
    'action: spam',
    'action_reason: "pookie_cm"',
    'moderators_exempt: false',
    END_MARKER,
  ].join('\n')
}

function replaceManagedBlock(content: string, block: string): string {
  const start = content.indexOf(START_MARKER)
  const end = content.indexOf(END_MARKER)

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Gif-Guardian managed AutoModerator block was not found.')
  }

  const endExclusive = end + END_MARKER.length

  return content.slice(0, start) + block + content.slice(endExclusive)
}

export async function getAutoModStatus(subredditName: string): Promise<{
  pageExists: boolean
  managedBlockPresent: boolean
}> {
  try {
    const page = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)

    return {
      pageExists: true,
      managedBlockPresent:
        page.content.includes(START_MARKER) &&
        page.content.includes(END_MARKER),
    }
  } catch {
    return {
      pageExists: false,
      managedBlockPresent: false,
    }
  }
}

export async function initializeAutoMod(subredditName: string): Promise<void> {
  const page = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)

  const gifs = await listRestrictedGifs()

  const block = buildManagedBlock(
    gifs.filter(gif => gif.status === 'active').map(gif => gif.giphyId),
  )

  const hasBlock =
    page.content.includes(START_MARKER) && page.content.includes(END_MARKER)

  let updatedContent: string

  if (hasBlock) {
    updatedContent = replaceManagedBlock(page.content, block)
  } else {
    const separator =
      page.content.length === 0 || page.content.endsWith('\n') ? '' : '\n'

    updatedContent = `${page.content}${separator}\n${block}\n`
  }

  await reddit.updateWikiPage({
    subredditName,
    page: AUTOMOD_PAGE,
    content: updatedContent,
    reason: 'Gif-Guardian AutoModerator sync',
  })
}

export async function syncAutoMod(subredditName: string): Promise<number> {
  const page = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE)

  const activeIds = (await listRestrictedGifs())
    .filter(gif => gif.status === 'active')
    .map(gif => gif.giphyId)
    .sort()

  const block = buildManagedBlock(activeIds)

  const updatedContent = replaceManagedBlock(page.content, block)

  if (updatedContent !== page.content) {
    await reddit.updateWikiPage({
      subredditName,
      page: AUTOMOD_PAGE,
      content: updatedContent,
      reason: 'Gif-Guardian AutoModerator sync',
    })
  }

  return activeIds.length
}
