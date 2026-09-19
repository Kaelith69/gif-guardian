import assert from 'node:assert/strict'
import test from 'node:test'
import {parseRestrictedGif, RegistryValidationError} from './validation.ts'

test('validates a restricted GIF record', () => {
  const record = parseRestrictedGif(
    JSON.stringify({
      giphyId: 'ABC123',
      status: 'active',
      reason: 'pookie_cm',
      firstAddedAt: '2026-09-19T00:00:00.000Z',
      firstAddedBy: 'moderator',
      lastActionAt: '2026-09-19T00:00:00.000Z',
      lastActionBy: 'moderator',
      sourceComment: 't1_abc',
      sourceUrl: 'https://www.reddit.com/r/test/comments/post/abc/',
      sourcePost: 't3_post',
    }),
  )

  assert.equal(record.giphyId, 'ABC123')
})

test('rejects malformed registry records', () => {
  assert.throws(
    () => parseRestrictedGif('{"giphyId":"ABC","status":"unknown"}'),
    RegistryValidationError,
  )
})
