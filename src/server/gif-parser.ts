const GIPHY_EMBED_REGEX = /!\[gif\]\(giphy\|([A-Za-z0-9_-]+)(?:\|[^)]*)?\)/g

export function extractGiphyIds(body: string): string[] {
  const ids: string[] = []

  for (const match of body.matchAll(GIPHY_EMBED_REGEX)) {
    const id = match[1]

    if (id && !ids.includes(id)) {
      ids.push(id)
    }
  }

  return ids
}
