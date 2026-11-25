function defaultBase(): string | undefined {
  const doc = (globalThis as { document?: { baseURI?: string } }).document
  return doc?.baseURI
}

export function resolveRequestUrl(
  logical: string,
  base: string | undefined = defaultBase(),
): string {
  if (base === undefined) return logical
  try {
    const url = new URL(logical.replace(/^\/+/u, ''), base)
    return `${url.pathname}${url.search}`
  } catch {
    return logical
  }
}
