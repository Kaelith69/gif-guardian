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

  assert.match(block, /# === COCONAAD GIF GUARD START ===/)
  assert.match(block, /action: spam/)
  assert.match(block, /ABC\|XYZ/)
})

test('preserves unmanaged content while replacing the managed block', () => {
  const before =
    'type: post\n\n# === COCONAAD GIF GUARD START ===\nold\n# === COCONAAD GIF GUARD END ===\n\ntype: comment'
  const result = ensureManagedBlock(before, buildManagedBlock(['ABC']))

  assert.match(result, /^type: post\n/)
  assert.match(result, /type: comment$/)
  assert.doesNotMatch(result, /\nold\n/)
})

test('appends a managed block when markers are absent', () => {
  const result = ensureManagedBlock('type: post', buildManagedBlock(['ABC']))

  assert.match(result, /^type: post\n/)
  assert.match(result, /# === COCONAAD GIF GUARD START ===/)
})

test('rejects incomplete managed markers', () => {
  assert.throws(
    () =>
      ensureManagedBlock(
        '# === COCONAAD GIF GUARD START ===\ntype: comment',
        buildManagedBlock(['ABC']),
      ),
    /markers are incomplete/,
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
