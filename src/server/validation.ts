import type {GifStatus, RestrictedGif} from './gif.ts'

const GIPHY_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Gif-Guardian registry data: ${message}`)
    this.name = 'RegistryValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireString(
  value: unknown,
  field: string,
  options: {allowEmpty?: boolean} = {},
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.trim() === '')
  ) {
    throw new RegistryValidationError(`${field} must be a non-empty string.`)
  }

  return value
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field)

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new RegistryValidationError(`${field} must be an ISO timestamp.`)
  }

  return timestamp
}

export function parseRestrictedGif(value: string): RestrictedGif {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RegistryValidationError('record is not valid JSON.')
  }

  if (!isRecord(parsed)) {
    throw new RegistryValidationError('record must be an object.')
  }

  const giphyId = requireString(parsed.giphyId, 'giphyId')

  if (!GIPHY_ID_PATTERN.test(giphyId)) {
    throw new RegistryValidationError(
      'giphyId contains unsupported characters.',
    )
  }

  const status = parsed.status

  if (status !== 'active' && status !== 'disabled') {
    throw new RegistryValidationError('status must be active or disabled.')
  }

  return {
    giphyId,
    status,
    reason: requireString(parsed.reason, 'reason'),
    firstAddedAt: requireTimestamp(parsed.firstAddedAt, 'firstAddedAt'),
    firstAddedBy:
      parsed.firstAddedBy === undefined
        ? undefined
        : requireString(parsed.firstAddedBy, 'firstAddedBy'),
    lastActionAt: requireTimestamp(parsed.lastActionAt, 'lastActionAt'),
    lastActionBy:
      parsed.lastActionBy === undefined
        ? undefined
        : requireString(parsed.lastActionBy, 'lastActionBy'),
    sourceComment: requireString(parsed.sourceComment, 'sourceComment'),
    sourceUrl: requireString(parsed.sourceUrl, 'sourceUrl'),
    sourcePost: requireString(parsed.sourcePost, 'sourcePost'),
  }
}

export function parseGifStatus(value: unknown): GifStatus {
  if (value !== 'active' && value !== 'disabled') {
    throw new RegistryValidationError('status must be active or disabled.')
  }

  return value
}

export function parseJsonRecord<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new RegistryValidationError(`${label} is not valid JSON.`)
  }
}
