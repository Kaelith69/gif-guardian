import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildManagedBlock,
  buildRule,
  ensureManagedBlock,
  packIds,
} from './automod.ts'

test('builds a spam rule for active IDs', () => {
  const block = buildManagedBlock([
    'ABC',
    'XYZ',
  ])

  assert.match(
    block,
    /# === COCONAAD GIF GUARD START ===/,
  )
  assert.match(
    block,
    /action: spam/,
  )
  assert.match(
    block,
    /ABC\|XYZ/,
  )
})

test('builds an explicit empty restriction block', () => {
  const block = buildManagedBlock([])

  assert.match(
    block,
    /no active GIF restrictions/,
  )
  assert.match(
    block,
    /COCONAAD GIF GUARD END/,
  )
})

test('preserves unmanaged content while replacing the managed block', () => {
  const before =
    'type: post\n\n' +
    '# === COCONAAD GIF GUARD START ===\n' +
    'old\n' +
    '# === COCONAAD GIF GUARD END ===\n\n' +
    'type: comment'

  const result = ensureManagedBlock(
    before,
    buildManagedBlock(['ABC']),
  )

  assert.match(
    result,
    /^type: post\n/,
  )
  assert.match(
    result,
    /type: comment$/,
  )
  assert.doesNotMatch(
    result,
    /\nold\n/,
  )
})

test('appends a managed block when markers are absent', () => {
  const result =
    ensureManagedBlock(
      'type: post',
      buildManagedBlock(['ABC']),
    )

  assert.match(
    result,
    /^type: post\n/,
  )
  assert.match(
    result,
    /# === COCONAAD GIF GUARD START ===/,
  )
})

test('appends a managed block to empty content without a leading blank line', () => {
  const result =
    ensureManagedBlock(
      '',
      buildManagedBlock(['ABC']),
    )

  assert.match(
    result,
    /^# === COCONAAD GIF GUARD START ===/,
  )
})

test('rejects incomplete managed markers', () => {
  assert.throws(
    () =>
      ensureManagedBlock(
        '# === COCONAAD GIF GUARD START ===\n' +
          'type: comment',
        buildManagedBlock(['ABC']),
      ),
    /duplicate or incomplete markers/,
  )
})

test('rejects duplicate managed markers', () => {
  const content =
    '# === COCONAAD GIF GUARD START ===\n' +
    'one\n' +
    '# === COCONAAD GIF GUARD END ===\n' +
    '# === COCONAAD GIF GUARD START ===\n' +
    'two\n' +
    '# === COCONAAD GIF GUARD END ==='

  assert.throws(
    () =>
      ensureManagedBlock(
        content,
        buildManagedBlock(['ABC']),
      ),
    /duplicate or incomplete markers/,
  )
})

test('rejects reversed managed markers', () => {
  const content =
    '# === COCONAAD GIF GUARD END ===\n' +
    'type: comment\n' +
    '# === COCONAAD GIF GUARD START ==='

  assert.throws(
    () =>
      ensureManagedBlock(
        content,
        buildManagedBlock(['ABC']),
      ),
    /markers are in the wrong order/,
  )
})

test('packs IDs without exceeding the configured rule size', () => {
  const groups = packIds(
    Array.from(
      {length: 3_000},
      (_, index) => `ID${index}`,
    ),
  )

  assert.ok(groups.length > 1)

  for (const group of groups) {
    assert.ok(
      Buffer.byteLength(
        buildRule(group),
        'utf8',
      ) <= 8_000,
    )
  }
})