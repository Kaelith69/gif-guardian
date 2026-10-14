import assert from 'node:assert/strict'
import test from 'node:test'
import {parseAuditRecord} from './audit.ts'
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

test('maps legacy registry records to the current shape', () => {
  const record = parseRestrictedGif(
    JSON.stringify({
      giphyId: 'LEGACY',
      status: 'active',
      reason: 'old-rule',
      addedAt: '2026-09-19T00:00:00.000Z',
      addedBy: 'moderator',
      sourceComment: 't1_abc',
      sourcePost: 't3_post',
      originalUrl: 'https://giphy.com/gifs/LEGACY',
    }),
  )

  assert.equal(record.firstAddedAt, record.lastActionAt)
  assert.equal(record.sourceUrl, 'https://giphy.com/gifs/LEGACY')
})

test('validates audit records before exposing them', () => {
  const record = parseAuditRecord(
    JSON.stringify({
      id: 1,
      action: 'restrict',
      status: 'success',
      moderator: 'moderator',
      at: '2026-09-19T00:00:00.000Z',
    }),
  )

  assert.equal(record.id, 1)
  assert.throws(
    () => parseAuditRecord(JSON.stringify({...record, status: 'unknown'})),
    /Invalid Gif-Guardian audit record/,
  )
})
