// A fake of ZenMux's API for the tests: a local server the plugin's SITE is
// pointed at. route("GET /path", h) answers a request; seen lists what came.
import { _internal } from "./index.mjs"

export function fakeZenMux() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, path: url.pathname, headers: req.headers })
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(req)
    },
  })
  const was = _internal.SITE.api
  _internal.SITE.api = `http://127.0.0.1:${server.port}/api/v1`
  return {
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      _internal.SITE.api = was
    },
  }
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
