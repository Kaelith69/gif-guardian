export type GifStatus = 'active' | 'disabled'

export type RestrictedGif = {
  giphyId: string
  status: GifStatus
  reason: string
  addedBy: string
  addedAt: string
  sourceComment: string
  sourcePost: string
  originalUrl: string
}
