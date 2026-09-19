import {media} from '@devvit/web/server'

export async function createGifPreview(giphyId: string): Promise<string> {
  const sourceUrl = `https://media.giphy.com/media/${encodeURIComponent(giphyId)}/200.gif`

  const asset = await media.upload({
    url: sourceUrl,
    type: 'gif',
  })

  if (!asset.mediaUrl) {
    throw new Error(`Reddit did not return a media URL for GIPHY ${giphyId}.`)
  }

  return asset.mediaUrl
}
