// An upstream refusal Magpie does not recognise is rewritten so a routing
// group falls back. Statuses and wordings Magpie already handles are not.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { ZenMuxPlanAuthPlugin, _internal } from "./index.mjs"
import { fakeZenMux, json } from "./fake.mjs"

let f
afterEach(() => {
  f?.close()
  f = undefined
})

// the refusal a routing group was stopping on
const CALL = "Invalid 'input[115].call_id': string too long. Expected a string with maximum length 64, but got a string with length 68 instead. (request_id: 90a2d0ffea6f4308903e10273e64775f)"

const zen = (status, message, extra = {}) => JSON.stringify({ error: { code: String(status), type: extra.type ?? "invalid_params", message, ...extra } })

const said = (out) => JSON.parse(out.body).error

test("a call_id the upstream rejected is a shape Magpie falls back on", () => {
  const out = _internal.providerError(400, zen(400, CALL))
  expect(out.status).toBe(400)
  const e = said(out)
  expect(e.type).toBe("invalid_request_error")
  expect(e.code).toBe("unknown_parameter")
  expect(e.message).not.toMatch(/too long/i)
  expect(e.message).toContain("over the limit")
  expect(e.message).toContain("maximum length 64")
  expect(e.message).toContain("length 68")
  expect(e.message).toContain("call_id")
  expect(e.message).toContain("90a2d0ffea6f4308903e10273e64775f")
})

test("the same refusal worded only as a length, or as too large or too big", () => {
  for (const message of [
    "Expected a string with maximum length 64, but got a string with length 68 instead.",
    "Invalid 'input[3].id': string too large. Expected a string with maximum length 64, but got a string with length 68 instead.",
    "Invalid \"tools[0].id\": string too big. Expected a string with maximum length 64, but got a string with length 68 instead.",
  ]) {
    const out = _internal.providerError(400, zen(400, message))
    expect(out?.status).toBe(400)
    const e = said(out)
    expect(e.code).toBe("unknown_parameter")
    expect(e.message).not.toMatch(/too long|too large|too big/i)
    expect(e.message).toContain("64")
  }
})

test("an upstream 422 is the same shape, and keeps 422", () => {
  const out = _internal.providerError(422, JSON.stringify({
    error: { code: "422", type: "provider_unprocessable_entity_error", message: "the tool schema is not one this model takes" },
  }))
  expect(out.status).toBe(422)
  expect(said(out).code).toBe("unknown_parameter")
  expect(said(out).message).toContain("tool schema")
})

test("what Magpie already classifies is left unchanged", () => {
  const same = [
    [400, JSON.stringify({ error: { message: "Unknown parameter: 'reasoning.summary'.", code: "unknown_parameter" } })],
    [400, JSON.stringify({ error: { message: "string too long", code: "unknown_parameter" } })],
    [400, JSON.stringify({ error: { message: "prompt is too long" } })],
    [400, JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens" } })],
    [400, JSON.stringify({ error: { message: "内容太长了，请精简输入或开启新对话 (request_id: abc)" } })],
    [422, JSON.stringify({ error: { code: "422", type: "provider_unprocessable_entity_error", message: "prompt is too long" } })],
    [400, zen(400, "Parameter messages is required")],
    [400, zen(400, "Model openai/gpt-5.5 is not valid")],
    [400, JSON.stringify({ error: { message: "messages: field required" } })],
    [400, JSON.stringify({ error: { message: "tools.0.input_schema: Field required" } })],
    [400, zen(400, "You exceeded your current quota (request_id: abc)")],
    [400, zen(400, "Parameter temperature is not valid")],
    [429, zen(429, CALL, { type: "rate_limit" })],
    [413, JSON.stringify({ error: { code: "413", type: "invalid_params", message: "Prompt is too long" } })],
    [401, zen(401, CALL)],
    [500, zen(500, CALL, { type: "provider_error" })],
  ]
  for (const [status, body] of same) expect(_internal.providerError(status, body)).toBeNull()
})

async function loader() {
  f = fakeZenMux()
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  return hooks.auth.loader(async () => ({ type: "api", key: "sk-ss-v1-test" }))
}

test("the loader's fetch rewrites the refusal the fake answers with", async () => {
  const loaded = await loader()
  f.route("POST /api/v1/chat/completions", () => json({ error: { code: "400", type: "invalid_params", message: CALL } }, 400))
  const res = await loaded.fetch(_internal.SITE.api + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-ss-v1-test", "content-type": "application/json" },
    body: "{}",
  })
  expect(res.status).toBe(400)
  expect(res.headers.get("content-type")).toBe("application/json")
  const e = (await res.json()).error
  expect(e.code).toBe("unknown_parameter")
  expect(e.message).not.toMatch(/too long/i)
  expect(e.message).toContain("maximum length 64")
  expect(e.message).toContain("length 68")
  expect(f.seen[0].path).toBe("/api/v1/chat/completions")
  expect(f.seen[0].headers.get("authorization")).toBe("Bearer sk-ss-v1-test")
})

test("a reply, a rate limit and a platform check pass through the fetch", async () => {
  const loaded = await loader()
  const ok = { choices: [{ message: { content: "hi" } }] }
  f.route("POST /api/v1/chat/completions", (req) => {
    if (req.headers.get("x-case") === "429") return json({ error: { message: "Rate limit exceeded", type: "rate_limit", code: "429" } }, 429)
    if (req.headers.get("x-case") === "400") return json({ error: { message: "Parameter messages is required", type: "invalid_params", code: "400" } }, 400)
    return json(ok)
  })
  const post = (x) => loaded.fetch(_internal.SITE.api + "/chat/completions", { method: "POST", headers: { "x-case": x }, body: "{}" })
  expect(await (await post("200")).json()).toEqual(ok)
  const limited = await post("429")
  expect(limited.status).toBe(429)
  expect(await limited.json()).toEqual({ error: { message: "Rate limit exceeded", type: "rate_limit", code: "429" } })
  const missing = await post("400")
  expect(missing.status).toBe(400)
  const missingText = await missing.text()
  expect(missingText).toContain("Parameter messages is required")
  expect(missingText).not.toContain("unknown_parameter")
})

test("an error-only event stream, keep-alives included, is that 400", async () => {
  const loaded = await loader()
  const raw = `: ZENMUX PROCESSING\n\ndata: ${JSON.stringify({ error: { code: "400", type: "invalid_params", message: CALL } })}\n\n`
  const bytes = new TextEncoder().encode(raw)
  const mid = Math.floor(bytes.length / 2)
  f.route("POST /api/v1/chat/completions", () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, mid))
      controller.enqueue(bytes.subarray(mid))
      controller.close()
    },
  }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }))
  const res = await loaded.fetch(_internal.SITE.api + "/chat/completions", { method: "POST" })
  expect(res.status).toBe(400)
  const e = (await res.json()).error
  expect(e.code).toBe("unknown_parameter")
  expect(e.message).not.toMatch(/too long/i)
  expect(e.message).toContain("length 68")
})

test("a role chunk is not content yet; a delta or a tool call is", async () => {
  const loaded = await loader()
  const events = (rows) => rows.map((row) => (typeof row === "string" ? row : "data: " + JSON.stringify(row))).join("\n\n") + "\n\n"
  f.route("POST /api/v1/chat/completions", (req) => {
    const which = req.headers.get("x-case")
    const rows = which === "role"
      ? [{ choices: [{ delta: { role: "assistant", content: "" } }] }, { error: { code: "400", type: "invalid_params", message: CALL } }]
      : which === "tool"
        ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: "" } }] } }] }, { error: { message: CALL, type: "invalid_params" } }]
        : [": ZENMUX PROCESSING", { choices: [{ delta: { content: "hello" } }] }, { error: { message: CALL, type: "invalid_params" } }]
    return new Response(events(rows), { status: 200, headers: { "content-type": "text/event-stream" } })
  })
  const post = (x) => loaded.fetch(_internal.SITE.api + "/chat/completions", { method: "POST", headers: { "x-case": x } })
  const role = await post("role")
  expect(role.status).toBe(400)
  expect((await role.json()).error.message).not.toMatch(/too long/i)
  const begun = await post("content")
  expect(begun.status).toBe(200)
  const text = await begun.text()
  expect(text).toContain("hello")
  expect(text).toContain("too long")
  expect(text).toContain("ZENMUX PROCESSING")
  const tool = await post("tool")
  expect(tool.status).toBe(200)
  expect(await tool.text()).toContain("call_1")
})

test("a streamed overflow or rate limit is not rewritten", async () => {
  const loaded = await loader()
  f.route("POST /api/v1/chat/completions", (req) => {
    const message = req.headers.get("x-case") === "quota" ? "Rate limit exceeded" : "prompt is too long"
    const type = req.headers.get("x-case") === "quota" ? "rate_limit" : "invalid_params"
    const body = `: ZENMUX PROCESSING\n\ndata: ${JSON.stringify({ error: { message, type, code: "400" } })}\n\n`
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  })
  const post = (x) => loaded.fetch(_internal.SITE.api + "/chat/completions", { method: "POST", headers: { "x-case": x } })
  expect(await (await post("long")).text()).toContain("prompt is too long")
  expect((await post("long")).status).toBe(200)
  const quota = await post("quota")
  expect(quota.status).toBe(200)
  expect(await quota.text()).toContain("Rate limit exceeded")
})
