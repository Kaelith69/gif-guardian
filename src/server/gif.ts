export type GifStatus = 'active' | 'disabled'

export type RestrictedGif = {
  giphyId: string
  status: GifStatus
  reason: string
  firstAddedAt: string
  firstAddedBy?: string
  lastActionAt: string
  lastActionBy?: string
  sourceComment: string
  sourceUrl: string
  sourcePost: string
}
