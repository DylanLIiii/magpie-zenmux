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
        return { baseURL: SITE.api, apiKey: auth.key }
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
              validate: (v) => (!v || /^sk-mg-/.test(v.trim()) ? undefined : "a Management API key starts with sk-mg-"),
            },
          ],
        },
      ],
    },
  }
}

// for tests
export const _internal = { ID, SITE, MODELS, parseModels, usageOf, windowOf, managementKey }
