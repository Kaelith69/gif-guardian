import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildManagedBlock,
  buildRule,
  ensureManagedBlock,
  packIds,
} from './automod.ts'

test('builds a spam rule for active IDs', () => {
  const block = buildManagedBlock(['ABC', 'XYZ'])

  assert.match(block, /# === GIF GUARDIAN START ===/)
  assert.match(block, /action: spam/)
  assert.match(block, /ABC\|XYZ/)
})

test('builds an explicit empty restriction block', () => {
  const block = buildManagedBlock([])

  assert.match(block, /no active GIF restrictions/)
  assert.match(block, /# === GIF GUARDIAN END ===/)
})

test('preserves unmanaged content while replacing the managed block', () => {
  const before =
    'type: post\n\n' +
    '# === GIF GUARDIAN START ===\n' +
    'old\n' +
    '# === GIF GUARDIAN END ===\n\n' +
    'type: comment'

  const result = ensureManagedBlock(before, buildManagedBlock(['ABC']))

  assert.match(result, /^type: post\n/)
  assert.match(result, /type: comment$/)
  assert.doesNotMatch(result, /\nold\n/)
})

test('appends a managed block when markers are absent', () => {
  const result = ensureManagedBlock('type: post', buildManagedBlock(['ABC']))

  assert.match(result, /^type: post\n/)
  assert.match(result, /# === GIF GUARDIAN START ===/)
})

test('appends a managed block to empty content without a leading blank line', () => {
  const result = ensureManagedBlock('', buildManagedBlock(['ABC']))

  assert.match(result, /^# === GIF GUARDIAN START ===/)
})

test('rejects incomplete managed markers', () => {
  assert.throws(
    () =>
      ensureManagedBlock(
        '# === GIF GUARDIAN START ===\n' + 'type: comment',
        buildManagedBlock(['ABC']),
      ),
    /duplicate or incomplete markers/,
  )
})

test('rejects duplicate managed markers', () => {
  const content =
    '# === GIF GUARDIAN START ===\n' +
    'one\n' +
    '# === GIF GUARDIAN END ===\n' +
    '# === GIF GUARDIAN START ===\n' +
    'two\n' +
    '# === GIF GUARDIAN END ==='

  assert.throws(
    () => ensureManagedBlock(content, buildManagedBlock(['ABC'])),
    /duplicate or incomplete markers/,
  )
})

test('rejects reversed managed markers', () => {
  const content =
    '# === GIF GUARDIAN END ===\n' +
    'type: comment\n' +
    '# === GIF GUARDIAN START ==='

  assert.throws(
    () => ensureManagedBlock(content, buildManagedBlock(['ABC'])),
    /markers are in the wrong order/,
  )
})

test('packs IDs without exceeding the configured rule size', () => {
  const groups = packIds(
    Array.from({length: 3_000}, (_, index) => `ID${index}`),
  )

  assert.ok(groups.length > 1)

  for (const group of groups) {
    assert.ok(Buffer.byteLength(buildRule(group), 'utf8') <= 8_000)
  }
})
