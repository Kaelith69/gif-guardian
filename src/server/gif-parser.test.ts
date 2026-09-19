import assert from 'node:assert/strict'
import test from 'node:test'
import {extractGiphyIds} from './gif-parser.ts'

test('extracts a single GIPHY ID', () => {
  assert.deepEqual(extractGiphyIds('![gif](giphy|ABC123)'), ['ABC123'])
})

test('extracts multiple IDs', () => {
  assert.deepEqual(extractGiphyIds('![gif](giphy|ABC) ![gif](giphy|XYZ_9)'), [
    'ABC',
    'XYZ_9',
  ])
})

test('removes duplicate IDs', () => {
  assert.deepEqual(
    extractGiphyIds('![gif](giphy|ABC) ![gif](giphy|ABC|extra)'),
    ['ABC'],
  )
})

test('ignores malformed embeds', () => {
  assert.deepEqual(extractGiphyIds('![gif](giphy|) ![gif](other|ABC)'), [])
})

test('supports extended embeds', () => {
  assert.deepEqual(extractGiphyIds('![gif](giphy|ABC|width=400&height=300)'), [
    'ABC',
  ])
})
