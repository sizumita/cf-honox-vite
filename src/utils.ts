export const safeParseUrlPath = (value: string): string | undefined => {
  try {
    return new URL(value, "http://localhost").pathname
  } catch {
    return undefined
  }
}

export const normalizeBasePath = (base?: string): string => {
  if (!base || base === "/") {
    return ""
  }
  const collapsed = (base.startsWith("/") ? base : `/${base}`).replace(/\/+/g, "/")
  return collapsed.replace(/\/+$/g, "")
}

export const createBasePathRewriter = (base?: string) => {
  const normalizedBase = normalizeBasePath(base)
  if (!normalizedBase) {
    return undefined
  }
  const prefixLength = normalizedBase.length
  const prefixWithSlash = `${normalizedBase}/`
  return (request: Request) => {
    const url = new URL(request.url)
    const { pathname } = url
    if (pathname === normalizedBase) {
      url.pathname = "/"
    } else if (pathname.startsWith(prefixWithSlash)) {
      url.pathname = pathname.slice(prefixLength) || "/"
    } else {
      return request
    }
    return new Request(url, request)
  }
}

export const createBasePathGuard = (base?: string) => {
  const normalizedBase = normalizeBasePath(base)
  if (!normalizedBase) {
    return () => true
  }
  const withTrailingSlash = `${normalizedBase}/`
  return (pathname?: string) => {
    return !!pathname && (pathname === normalizedBase || pathname.startsWith(withTrailingSlash))
  }
}
