import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildManagedBlock,
  buildRule,
  buildUrlRule,
  ensureManagedBlock,
  packIds,
} from './automod.ts'

test('builds a spam rule for active IDs', () => {
  const block = buildManagedBlock(['ABC', 'XYZ'])

  assert.match(block, /# === GIF GUARDIAN START ===/)
  assert.match(block, /type: comment/)
  assert.match(block, /type: submission/)
  assert.match(block, /url \(regex\):/)
  assert.match(block, /action: spam/)
  assert.match(block, /ABC\|XYZ/)
  assert.match(block, /body \(includes, regex\):/)
  assert.match(block, /\n---\ntype: /)
})

test('matches exact GIF embeds in both post and comment rules', () => {
  const rule = buildRule(['ABC'])
  const regexSource = rule.match(/body \(includes, regex\): '([^']+)'/)?.[1]

  assert.ok(regexSource)

  const regex = new RegExp(regexSource)

  assert.match('![gif](giphy|ABC)', regex)
  assert.match('![gif](giphy|ABC|width=400&height=300)', regex)
  assert.match('Post text ![gif](giphy|ABC)', regex)
  assert.doesNotMatch('![gif](giphy|ABCD)', regex)
  assert.doesNotMatch('![gif](giphy|XYZ)', regex)

  assert.match(buildRule(['ABC'], 'submission'), /type: submission/)

  const urlRule = buildUrlRule(['ABC'])
  const urlRegex = new RegExp(
    urlRule.match(/url \(regex\): '([^']+)'/)?.[1] ?? '',
  )

  assert.match('https://media.giphy.com/media/ABC/giphy.gif', urlRegex)
  assert.match('https://giphy.com/gifs/funny-title-ABC', urlRegex)
  assert.doesNotMatch('https://media.giphy.com/media/ABCD/giphy.gif', urlRegex)
})

test('separates every managed rule as a valid AutoModerator document', () => {
  const managed = buildManagedBlock(['ABC', 'XYZ'])
    .replace('# === GIF GUARDIAN START ===\n', '')
    .replace('\n# === GIF GUARDIAN END ===', '')
  const documents = managed.split('\n---\n')

  assert.ok(documents.length >= 3)
  assert.ok(documents.every(document => document.includes('action: spam')))
})

test('does not include moderation reasons in the managed block', () => {
  const block = buildManagedBlock(['ABC', 'XYZ'])

  assert.doesNotMatch(block, /action_reason:/)
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
