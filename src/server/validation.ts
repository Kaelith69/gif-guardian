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

  let record: Record<string, unknown> = parsed

  const legacy =
    record.firstAddedAt === undefined &&
    record.lastActionAt === undefined &&
    record.addedAt !== undefined

  if (legacy) {
    record = {
      ...record,
      firstAddedAt: record.addedAt,
      firstAddedBy: record.addedBy,
      lastActionAt: record.addedAt,
      lastActionBy: record.addedBy,
      sourceUrl: record.sourceUrl ?? record.originalUrl,
    }
  }

  const giphyId = requireString(record.giphyId, 'giphyId')

  if (!GIPHY_ID_PATTERN.test(giphyId)) {
    throw new RegistryValidationError(
      'giphyId contains unsupported characters.',
    )
  }

  const status = record.status

  if (status !== 'active' && status !== 'disabled') {
    throw new RegistryValidationError('status must be active or disabled.')
  }

  return {
    giphyId,
    status,
    reason: requireString(record.reason, 'reason'),
    firstAddedAt: requireTimestamp(record.firstAddedAt, 'firstAddedAt'),
    firstAddedBy:
      record.firstAddedBy === undefined
        ? undefined
        : requireString(record.firstAddedBy, 'firstAddedBy'),
    lastActionAt: requireTimestamp(record.lastActionAt, 'lastActionAt'),
    lastActionBy:
      record.lastActionBy === undefined
        ? undefined
        : requireString(record.lastActionBy, 'lastActionBy'),
    sourceComment: requireString(record.sourceComment, 'sourceComment'),
    sourceUrl: requireString(record.sourceUrl, 'sourceUrl'),
    sourcePost: requireString(record.sourcePost, 'sourcePost'),
    previewUrl:
      record.previewUrl === undefined
        ? undefined
        : requireHttpsUrl(record.previewUrl, 'previewUrl'),
  }
}

function requireHttpsUrl(value: unknown, field: string): string {
  const url = requireString(value, field)

  if (!/^https:\/\//i.test(url)) {
    throw new RegistryValidationError(`${field} must be a valid HTTPS URL.`)
  }

  return url
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
