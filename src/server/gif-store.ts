import {redis} from '@devvit/web/server'
import type {GifStatus, RestrictedGif} from './gif.ts'

const GIF_HASH_KEY = 'gif-guardian:restricted-gifs'

export async function getRestrictedGif(
  giphyId: string,
): Promise<RestrictedGif | undefined> {
  const value = await redis.hGet(GIF_HASH_KEY, giphyId)

  if (!value) {
    return undefined
  }

  return JSON.parse(value) as RestrictedGif
}

export async function saveRestrictedGif(gif: RestrictedGif): Promise<void> {
  await redis.hSet(GIF_HASH_KEY, {
    [gif.giphyId]: JSON.stringify(gif),
  })
}

export async function saveRestrictedGifs(gifs: RestrictedGif[]): Promise<void> {
  if (gifs.length === 0) {
    return
  }

  const values: Record<string, string> = {}

  for (const gif of gifs) {
    values[gif.giphyId] = JSON.stringify(gif)
  }

  await redis.hSet(GIF_HASH_KEY, values)
}

export async function deleteRestrictedGif(giphyId: string): Promise<void> {
  await redis.hDel(GIF_HASH_KEY, [giphyId])
}

export async function setGifStatus(
  giphyId: string,
  status: GifStatus,
): Promise<RestrictedGif | undefined> {
  const existing = await getRestrictedGif(giphyId)

  if (!existing) {
    return undefined
  }

  const updated: RestrictedGif = {
    ...existing,
    status,
  }

  await saveRestrictedGif(updated)

  return updated
}

export async function listRestrictedGifs(): Promise<RestrictedGif[]> {
  const values = await redis.hGetAll(GIF_HASH_KEY)

  return Object.values(values)
    .map(value => JSON.parse(value) as RestrictedGif)
    .sort((a, b) => a.giphyId.localeCompare(b.giphyId))
}
