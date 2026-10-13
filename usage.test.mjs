// The usage card: the plan, its end and its rolling 5-hour and 7-day
// windows, read with the Management API key, never the plan's own.
import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ZenMuxPlanAuthPlugin, _internal } from "./index.mjs"
import { fakeZenMux, json } from "./fake.mjs"

let f
let env
beforeEach(() => {
  env = process.env.ZENMUX_MANAGEMENT_API_KEY
  delete process.env.ZENMUX_MANAGEMENT_API_KEY
})
afterEach(() => {
  f?.close()
  f = undefined
  if (env === undefined) delete process.env.ZENMUX_MANAGEMENT_API_KEY
  else process.env.ZENMUX_MANAGEMENT_API_KEY = env
})

// the example in https://zenmux.ai/docs/api/platform/subscription-detail.html
const DETAIL = {
  success: true,
  data: {
    plan: { tier: "ultra", amount_usd: 200, interval: "month", expires_at: "2026-04-12T08:26:56.000Z" },
    currency: "usd",
    base_usd_per_flow: 0.03283,
    effective_usd_per_flow: 0.03283,
    account_status: "healthy",
    quota_5_hour: { usage_percentage: 0.0715, resets_at: "2026-03-24T08:35:09.000Z", max_flows: 800, used_flows: 57.2, remaining_flows: 742.8, used_value_usd: 1.88, max_value_usd: 26.27 },
    quota_7_day: { usage_percentage: 0.0673, resets_at: "2026-03-26T02:15:05.000Z", max_flows: 6182, used_flows: 416.11, remaining_flows: 5765.89, used_value_usd: 13.66, max_value_usd: 202.99 },
    quota_monthly: { max_flows: 34560, max_value_usd: 1134.33 },
  },
}

const auth = { type: "api", key: "sk-ss-v1-plan", metadata: { managementKey: "sk-mg-v1-mgmt" } }

test("the documented answer is the plan, its end and two windows", () => {
  expect(_internal.usageOf(DETAIL.data)).toEqual({
    plan: "ZenMux Ultra",
    until: "2026-04-12T08:26:56.000Z",
    windows: [
      { name: "5 hours", used: 7.15, resetsAt: "2026-03-24T08:35:09.000Z", span: 18000, amount: 57.2, limit: 800, unit: "flows" },
      { name: "7 days", used: 6.73, resetsAt: "2026-03-26T02:15:05.000Z", span: 604800, amount: 416.11, limit: 6182, unit: "flows" },
    ],
  })
})

test("a window not started has no reset; the docs' pro tier is Starter", () => {
  const u = _internal.usageOf({ plan: { tier: "pro" }, account_status: "healthy", quota_5_hour: { usage_percentage: 0, resets_at: null, max_flows: 50, used_flows: 0 } })
  expect(u.plan).toBe("ZenMux Starter")
  expect(u.windows).toEqual([{ name: "5 hours", used: 0, span: 18000, amount: 0, limit: 50, unit: "flows" }])
})

test("usage asks with the Management key, not the plan's", async () => {
  f = fakeZenMux()
  f.route("GET /api/v1/management/subscription/detail", () => json(DETAIL))
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.plan).toBe("ZenMux Ultra")
  expect(u.windows.length).toBe(2)
  expect(u.signIn).toBe("kept")
  expect(f.seen[0].headers.get("authorization")).toBe("Bearer sk-mg-v1-mgmt")
})

test("ZENMUX_MANAGEMENT_API_KEY stands in for a key not given", async () => {
  f = fakeZenMux()
  f.route("GET /api/v1/management/subscription/detail", () => json(DETAIL))
  process.env.ZENMUX_MANAGEMENT_API_KEY = "sk-mg-v1-env"
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  await hooks.auth.usage(async () => ({ type: "api", key: "sk-ss-v1-plan" }))
  expect(f.seen[0].headers.get("authorization")).toBe("Bearer sk-mg-v1-env")
})

test("without a Management key nothing is asked and the card says why", async () => {
  f = fakeZenMux()
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({ type: "api", key: "sk-ss-v1-plan", metadata: { managementKey: "" } }))
  expect(u.error).toContain("Management API key")
  expect(u.signIn).toBe("kept")
  expect(f.seen.length).toBe(0)
})

test("a Management key turned away is an error that keeps the plan's sign-in", async () => {
  f = fakeZenMux()
  f.route("GET /api/v1/management/subscription/detail", () => json({ success: false, error: { message: "invalid key" } }, 401))
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toContain("turned the Management API key away")
  expect(u.signIn).toBe("kept")
})

test("success false and an account not healthy are told", async () => {
  f = fakeZenMux()
  f.route("GET /api/v1/management/subscription/detail", () => json({ success: false, message: "boom" }))
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  expect((await hooks.auth.usage(async () => auth)).error).toBe("ZenMux subscription detail: boom")
  f.route("GET /api/v1/management/subscription/detail", () => json({ success: true, data: { ...DETAIL.data, account_status: "monitored" } }))
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toBe("ZenMux says the account is monitored")
  expect(u.windows.length).toBe(2)
})

test("not signed in with a key", async () => {
  const hooks = await ZenMuxPlanAuthPlugin({ client: {} })
  expect(await hooks.auth.usage(async () => undefined)).toEqual({ error: "not signed in" })
})
