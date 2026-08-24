/**
 * Test helpers: a tiny fake `fetch` with route-based handlers and a canned
 * Response-like shape that GitHubApi and the OpenAI client can consume.
 */

/** Build a Response-like object (fetch API subset used by the clients). */
export function makeResponse({ status = 200, json, text, headers = {} }) {
  const headerMap = new Map(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  )
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
    },
    async json() {
      if (json !== undefined) return json
      return JSON.parse(text ?? '{}')
    },
    async text() {
      if (json !== undefined) return JSON.stringify(json)
      return text ?? ''
    },
  }
}

/**
 * Create a fake fetch dispatching to the first matching handler. Handlers not
 * consumed by any call are reported by `expectAllHandled()` so tests notice
 * silently-unexercised routes.
 */
export function createFakeFetch(handlers) {
  const used = new Set()
  const impl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const method = String(init.method ?? 'GET').toUpperCase()
    for (const handler of handlers) {
      if (handler.method && handler.method !== method) continue
      if (handler.pattern && !handler.pattern.test(url)) continue
      if (handler.after && !handler.after(url, init)) continue
      used.add(handler)
      return handler.respond(url, init, { calls: handler.calls ?? (handler.calls = []) })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }
  impl.expectAllHandled = () => {
    for (const handler of handlers) {
      if (!used.has(handler)) {
        throw new Error(`fake fetch handler was never used: ${handler.label ?? '?'}`)
      }
    }
  }
  return impl
}