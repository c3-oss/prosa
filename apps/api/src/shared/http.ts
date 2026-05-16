import type { FastifyRequest } from 'fastify'

type HeaderBag = Record<string, string | string[] | undefined>

function headersFromBag(bag: HeaderBag): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(bag)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, String(v))
    } else {
      headers.set(key, String(value))
    }
  }
  return headers
}

/** Project a Fastify request's headers into a WHATWG `Headers` instance. */
export function requestToHeaders(req: FastifyRequest): Headers {
  return headersFromBag(req.headers)
}

/** Same as {@link requestToHeaders} but for a tRPC context wrapping the request. */
export function headersFromTrpcCtx(ctx: { req: { headers: HeaderBag } }): Headers {
  return headersFromBag(ctx.req.headers)
}

/** Read a single header, returning the first value when multiple are present. */
export function readFirstHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}
