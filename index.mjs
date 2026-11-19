// ZenMux Builder Plan (zenmux.ai's subscription) as a magpie / OpenCode
// provider plugin.
//
// Requests go with the plan's own API key (sk-ss-v1-…) to ZenMux's
// OpenAI-compatible API, which takes them from the plan's Flows. The plan's
// quota — the rolling 5-hour and 7-day windows, how much of each is used and
// when each resets — is only told to a Management API key (sk-mg-v1-…), by
// GET /api/v1/management/subscription/detail
// (https://zenmux.ai/docs/api/platform/subscription-detail.html). That key
// is asked for at sign-in beside the plan's and kept in the account's
// metadata; without it requests work and the usage card says what's missing.

const ID = "zenmux-plan"
const CHAT = "@ai-sdk/openai-compatible"

// where ZenMux is; tests point it at their fake
const SITE = { api: "https://zenmux.ai/api/v1" }

const HOUR = 3600
const TIERS = { free: "Free", pro: "Starter", starter: "Starter", max: "Max", ultra: "Ultra" }

// until signed in, or when ZenMux's list doesn't answer
const MODELS = [
  { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
  { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5" },
  { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash" },
  { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3" },
  { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" },
]

const configModel = (m) => ({
  name: m.name ?? m.id,
  limit: { context: m.context ?? 0, output: m.output ?? 0 },
  ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
  ...(m.reasoning ? { reasoning: true } : {}),
  tool_call: true,
})

const runtimeModel = (m) => ({
  id: m.id,
  providerID: ID,
  name: m.name ?? m.id,
  api: { id: m.id, url: SITE.api, npm: CHAT },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: m.context ?? 0, output: m.output ?? 0 },
  capabilities: {
    temperature: true,
    reasoning: !!m.reasoning,
    attachment: !!m.images,
    toolcall: true,
    input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "",
  variants: {},
})

// parseModels is ZenMux's /models answer: the models that answer in text
function parseModels(body) {
  const out = []
  for (const m of body?.data ?? []) {
    if (!m?.id || typeof m.id !== "string") continue
    const outs = m.output_modalities ?? ["text"]
    if (!outs.includes("text")) continue
    const ins = m.input_modalities ?? []
    out.push({
      id: m.id,
      name: m.display_name || m.id,
      context: m.context_length ?? 0,
      output: m.max_tokens ?? 0,
      images: ins.includes("image"),
      reasoning: !!m.capabilities?.reasoning,
    })
  }
  return out
}

async function liveModels() {
  const res = await fetch(SITE.api + "/models", { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`ZenMux models: HTTP ${res.status}`)
  return parseModels(await res.json())
}

// managementKey is the account's Management API key: the one given at
// sign-in, else ZENMUX_MANAGEMENT_API_KEY
function managementKey(auth) {
  const k = auth?.metadata?.managementKey ?? auth?.managementKey
  if (typeof k === "string" && k.trim()) return k.trim()
  const env = process.env.ZENMUX_MANAGEMENT_API_KEY
  return env && env.trim() ? env.trim() : ""
}

const pct = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 10000) / 100 : 0)
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0)

// windowOf is one of the plan's rolling windows; resets_at is null until the
// first request starts it
function windowOf(name, span, q) {
  if (!q || typeof q !== "object") return null
  return {
    name,
    used: pct(q.usage_percentage),
    ...(q.resets_at ? { resetsAt: q.resets_at } : {}),
    span,
    amount: num(q.used_flows),
    limit: num(q.max_flows),
    unit: "flows",
  }
}

// usageOf is the card from subscription/detail's data
function usageOf(d) {
  const tier = String(d?.plan?.tier ?? "").toLowerCase()
  const windows = [windowOf("5 hours", 5 * HOUR, d?.quota_5_hour), windowOf("7 days", 7 * 24 * HOUR, d?.quota_7_day)].filter(Boolean)
  const status = d?.account_status
  return {
    plan: tier ? "ZenMux " + (TIERS[tier] ?? tier[0].toUpperCase() + tier.slice(1)) : "ZenMux",
    ...(d?.plan?.expires_at ? { until: d.plan.expires_at } : {}),
    windows,
    ...(status && status !== "healthy" ? { error: `ZenMux says the account is ${status}` } : {}),
  }
}

// Magpie asks the next member of a routing group for a 400 or 422 only when
// the body is a shape it knows (shapeWords: unknown_parameter among them),
// and that member doesn't rest. Anything else in those statuses is the
// request's own fault and stops the group. ZenMux's 400 invalid_params and
// 422 provider_unprocessable_entity_error are often an upstream's refusal
// of one field — a call_id longer than that vendor allows — worded so
// Magpie doesn't know it, and a long thread is then read as the prompt
// overflowing ("too long") and never retried. Said back as
// unknown_parameter, the next member is asked.
//
// Left as they arrived: statuses Magpie already retries, a prompt that
// really is too long, quota and credit, and ZenMux's own checks (a missing
// parameter, an unknown model, a bare "field required").
const shapeWords = /failed to deserialize|unknown (?:item |content |input )?(?:type|variant|field|parameter)|unknown_parameter|unrecognized (?:request argument|field|parameter)|extra (?:inputs|fields) are not permitted|additional properties are not allowed|schema exceeds the maximum (?:nesting )?depth|schema[^"]{0,60}\bnesting depth\b|function_declarations\[\d+\]\.parameters\b/i
const tooLongRe = /context_length_exceeded|prompt is too long|input is too long|(?:exceeds?|exceeded|over|beyond)(?: the)?(?: model'?s?)?(?: maximum)? context|context (?:length|limit|window) (?:exceeded|is exceeded)|context (?:window )?(?:is )?full\b|maximum context length|too many (?:input |prompt )?tokens|上下文(?:长度)?(?:超|过长)|超(?:过|出)(?:了)?(?:模型)?(?:的)?(?:最大)?上下文|input token count.*exceeds the maximum|maximum prompt length is \d|reduce the length of the messages|maximum allowed input length|longer than the model'?s context length|available context size|greater than the context length|prompt token count of [\d,]+ exceeds the limit|context window exceeds limit|exceeded model token limit|configured context size|prompt too long|prompt exceeds max length|context_window_exceeded|exceeded (?:max |maximum )?context length|range of input length should be|token limit exceeded|input tokens? (?:count )?(?:exceeds?|exceeded) (?:the )?(?:max(?:imum)? )?limit|(?:内容|输入|文本|提示词?|prompt|问题|对话|消息)(?:内容|文本)?(?:长度)?\s*(?:太长|过长|超长)|字数(?:太多|过多)|(?:内容|输入|文本|提示词?|prompt|问题|对话|消息)[^，。,.;；!！]{0,12}超(?:过|出)[^，。,.;；!！]{0,12}(?:长度|token|令牌|字数)|(?:输入|提示词?|prompt)\s*的?\s*(?:长度|token|令牌|字数)[^，。,.;；!！]{0,8}超(?:过|出)/i
const quotaWords = /quota|insufficient|balance|credit|billing|out of budget|budget (?:exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|频繁|速率|套餐|用量|上限/i
const creditWords = /insufficient.?(?:balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(?:不足|停)/i
const unservedWords = /model.{0,80}(?:not (?:supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(?:no such|unknown|invalid|unsupported) model|model_not_found|has no provider supported|deployment[ _]?not[ _]?found|deployment.{0,60}does ?n[o']t exist|模型.{0,12}(?:不存在|不支持|无权|未开通)/i
const refusedWords = /unapproved channel|illegal api invocation/i
const regionWords = /\buser location is not supported for the api use\b|unsupported_country_region_territory|country, region,? or territory not supported/i
// ZenMux's own validation, before an upstream sees the request
const platformCheck = /parameter\s+\S+\s+is required|model\s+\S+\s+is not valid|field required/i
// an upstream's field, as OpenAI words it, often with the vendor's request id
const upstreamField = /invalid\s+['"][^'"]+['"]|expected a string with maximum length|string too (?:long|large|big)|\(\s*request_id\s*:/i

const magpieRetries = (status) => status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 413 || status === 429 || status >= 500

function asText(body) {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body && typeof body === "object") return JSON.stringify(body)
  return body == null ? "" : String(body)
}

function readMessage(text) {
  try {
    const v = JSON.parse(text)
    const e = v?.error
    if (typeof e === "string" && e.trim()) return e
    if (e && typeof e === "object" && typeof e.message === "string") return e.message
    if (typeof v?.message === "string") return v.message
  } catch {
    // not JSON: the body itself is the message
  }
  return text.trim()
}

// "too long" on a field is not the prompt overflowing. Left in, a thread
// past half the window is told to compact and the next member is never asked.
function soften(message) {
  return message.replace(/\btoo long\b/gi, "over the limit").replace(/\btoo large\b/gi, "over the limit").replace(/\btoo big\b/gi, "over the limit")
}

// providerError is a ZenMux answer rewritten so Magpie falls back on it, or
// null when the answer should reach Magpie unchanged. status is 400 or 422.
function providerError(status, body) {
  if (status !== 400 && status !== 422) return null
  const text = asText(body)
  const message = readMessage(text)
  const hay = text + "\n" + message
  if (shapeWords.test(hay) || tooLongRe.test(hay) || quotaWords.test(hay) || creditWords.test(hay) || unservedWords.test(hay) || refusedWords.test(hay) || regionWords.test(hay) || platformCheck.test(hay)) return null
  const upstream = status === 422 && /provider_unprocessable_entity_error/i.test(hay)
  if (!upstream && !upstreamField.test(hay)) return null
  const said = soften(message).trim() || "the upstream provider rejected the request"
  return {
    status,
    body: JSON.stringify({ error: { message: said, type: "invalid_request_error", code: "unknown_parameter" } }),
  }
}

function carry(res, text) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(text, { status: res.status, statusText: res.statusText, headers })
}

function jsonResponse(next) {
  return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } })
}

// sseEvents splits one buffer into complete events. rest is the unfinished tail.
function sseEvents(buffer, flush) {
  const norm = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const parts = norm.split("\n\n")
  const rest = flush ? "" : (parts.pop() ?? "")
  const events = []
  for (const part of parts) {
    if (!part.trim()) continue
    const data = []
    for (const line of part.split("\n")) {
      if (!line || line.startsWith(":")) continue
      const i = line.indexOf(":")
      if (i < 0) continue
      if (line.slice(0, i) !== "data") continue
      let value = line.slice(i + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      data.push(value)
    }
    if (data.length) events.push(data.join("\n"))
  }
  return { events, rest }
}

function textOf(v) {
  if (typeof v === "string") return v
  if (Array.isArray(v)) return v.map(textOf).join("")
  if (v && typeof v === "object" && typeof v.text === "string") return v.text
  return ""
}

// hasContent says an event already carried part of the reply, so the stream
// can no longer be turned into a clean refusal the next member could answer.
function hasContent(j) {
  if (!j || typeof j !== "object") return false
  const choices = j.choices
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const d = c?.delta ?? c?.message ?? {}
      if (textOf(d.content) || textOf(d.reasoning_content) || textOf(d.reasoning) || textOf(d.refusal) || textOf(c?.text)) return true
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true
    }
  }
  if (typeof j.delta === "string" && j.delta) return true
  if (typeof j.type === "string" && /content_block_delta|output_text/.test(j.type)) return true
  return false
}

function isErrorEvent(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return false
  if (j.choices) return false
  if (j.error != null && j.error !== false) return true
  if (j.type === "error") return true
  return typeof j.message === "string" && (j.type != null || j.code != null)
}

function eventStatus(j) {
  const blob = typeof j === "string" ? j : JSON.stringify(j)
  if (/provider_unprocessable_entity_error/i.test(blob)) return 422
  return 400
}

function replay(res, chunks, reader) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  const stream = new ReadableStream({
    async pull(controller) {
      if (chunks.length) {
        controller.enqueue(chunks.shift())
        return
      }
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(stream, { status: res.status, statusText: res.statusText, headers })
}

// answerStream turns an event stream that failed before any reply into the
// same JSON a 400 or 422 would be. : ZENMUX PROCESSING is a keep-alive, not
// an event. Once a content delta has passed, the stream goes on unchanged.
async function answerStream(res) {
  if (!res.body) return res
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const chunks = []
  let tail = ""
  let errorEvent = null
  const consider = (flush) => {
    const parsed = sseEvents(tail, flush)
    tail = parsed.rest
    let sawContent = false
    for (const data of parsed.events) {
      if (!data || data === "[DONE]") continue
      let json
      try {
        json = JSON.parse(data)
      } catch {
        if (providerError(400, data) || providerError(422, data)) errorEvent = data
        else sawContent = true
        continue
      }
      if (hasContent(json)) sawContent = true
      else if (isErrorEvent(json)) errorEvent = json
    }
    return sawContent
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) {
        chunks.push(value)
        tail += dec.decode(value, { stream: true })
      }
      if (done) tail += dec.decode()
      if (consider(done)) return replay(res, chunks, reader)
      if (errorEvent) {
        const next = providerError(eventStatus(errorEvent), typeof errorEvent === "string" ? errorEvent : JSON.stringify(errorEvent))
        if (next) {
          await reader.cancel().catch(() => {})
          return jsonResponse(next)
        }
        return replay(res, chunks, reader)
      }
      if (done) break
    }
  } catch (e) {
    await reader.cancel().catch(() => {})
    throw e
  }
  return replay(res, chunks, reader)
}

// answer is the loader's fetch: ZenMux's reply, with an upstream refusal
// Magpie would not fall back from rewritten into one it does.
async function answer(res) {
  if (magpieRetries(res.status)) return res
  if (/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) return answerStream(res)
  if (res.status !== 400 && res.status !== 422) return res
  const text = await res.text()
  const next = providerError(res.status, text)
  if (!next) return carry(res, text)
  return jsonResponse(next)
}

async function subscriptionDetail(key) {
  const res = await fetch(SITE.api + "/management/subscription/detail", {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error("ZenMux turned the Management API key away (sk-mg-v1-…); sign in again with a valid one")
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new Error(`ZenMux subscription detail: HTTP ${res.status}, not JSON`)
  }
  if (!res.ok || body?.success === false || !body?.data) {
    const why = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`
    throw new Error("ZenMux subscription detail: " + why)
  }
  return body.data
}

export async function ZenMuxPlanAuthPlugin() {
  return {
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "ZenMux Builder Plan",
        npm: CHAT,
        api: SITE.api,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: ID,
      // ZenMux's live list; the configured one when it doesn't answer
      async models(provider) {
        try {
          const ms = await liveModels()
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, runtimeModel(m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          baseURL: SITE.api,
          apiKey: auth.key,
          // apiKey is applied before this runs. A refusal Magpie doesn't
          // know is rewritten; everything else, including a reply that has
          // already started, is ZenMux's own.
          async fetch(input, init) {
            return answer(await globalThis.fetch(input, init))
          },
        }
      },
      // the plan, its end and its 5-hour and 7-day windows; the window
      // resets a plan gets each month aren't told by the API, so aren't shown
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "not signed in" }
        const key = managementKey(auth)
        // a usage read never marks the plan's key: it isn't the one asked
        if (!key) return { error: "add a ZenMux Management API key (sk-mg-v1-…) to see the plan's quota", signIn: "kept" }
        try {
          return { ...usageOf(await subscriptionDetail(key)), signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      methods: [
        {
          type: "api",
          label: "ZenMux subscription API key (sk-ss-v1-…)",
          prompts: [
            {
              type: "text",
              key: "managementKey",
              message: "ZenMux Management API key (sk-mg-v1-…), to read the plan's quota and resets; leave empty to skip",
              placeholder: "sk-mg-v1-…",
            },
          ],
        },
      ],
    },
  }
}

// for tests
export const _internal = { ID, SITE, MODELS, parseModels, usageOf, windowOf, managementKey, providerError }
