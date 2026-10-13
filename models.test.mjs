// Requests go with the plan's key to ZenMux's OpenAI-compatible API; the
// models are ZenMux's live list, the ones that answer in text.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { ZenMuxPlanAuthPlugin, _internal } from "./index.mjs"
import { fakeZenMux, json } from "./fake.mjs"

let f
afterEach(() => {
  f?.close()
  f = undefined
})

test("the loader sends the plan's key to the API", async () => {
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  expect(await hooks.auth.loader(async () => ({ type: "api", key: "sk-ss-v1-plan", metadata: { managementKey: "sk-mg-v1-x" } })))
    .toEqual({ baseURL: "https://zenmux.ai/api/v1", apiKey: "sk-ss-v1-plan" })
  expect(await hooks.auth.loader(async () => undefined)).toEqual({})
})

test("one api method that asks for the Management key", async () => {
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const [m] = hooks.auth.methods
  expect(m.type).toBe("api")
  expect(m.prompts[0].key).toBe("managementKey")
  expect(m.prompts[0].validate("")).toBeUndefined()
  expect(m.prompts[0].validate("sk-mg-v1-abc")).toBeUndefined()
  expect(m.prompts[0].validate("sk-ss-v1-abc")).toContain("sk-mg-")
})

test("the live list keeps text models", async () => {
  f = fakeZenMux()
  f.route("GET /api/v1/models", () => json({ data: [
    { id: "anthropic/claude-sonnet-5", display_name: "Anthropic: Claude Sonnet 5", context_length: 1000000, max_tokens: 64000, input_modalities: ["text", "image"], output_modalities: ["text"], capabilities: { reasoning: true } },
    { id: "inclusionai/llada-image", display_name: "LLaDA-Image", input_modalities: ["text"], output_modalities: ["image"] },
  ] }))
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const ms = await hooks.provider.models({ models: { kept: {} } })
  expect(Object.keys(ms)).toEqual(["anthropic/claude-sonnet-5"])
  const m = ms["anthropic/claude-sonnet-5"]
  expect(m.providerID).toBe("zenmux-plan")
  expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(m.limit).toEqual({ context: 1000000, output: 64000 })
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.input.image).toBe(true)
})

test("a list ZenMux doesn't give keeps the configured one", async () => {
  f = fakeZenMux()
  f.route("GET /api/v1/models", () => new Response("down", { status: 503 }))
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const have = { kept: { id: "kept" } }
  expect(await hooks.provider.models({ models: have })).toBe(have)
})

test("config adds the provider with its fallback models", async () => {
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["zenmux-plan"]
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(Object.keys(p.models).length).toBe(_internal.MODELS.length)
})
