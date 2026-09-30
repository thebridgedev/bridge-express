# Bridge Express — Billing & Entitlements

You are adding **server-side billing enforcement** to an Express application that uses The Bridge.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `bridge.requireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In Express, an endpoint is `bridge.protect({ featureFlag: '…' })` on the route (or a route rule with `featureFlag`).

## What this guide covers

`bridge guide mechanisms` is the one-page model: the server decides and the client decorates, a POST increments the limit, counter vs gauge in one sentence, and the three ways a frontend shows a limit.

> **What "billing" means on the backend.** A backend plugin **reads** subscription state and **enforces** what the plan sells — nothing more. There is no checkout, no paywall, no plan selector, and no Stripe redirect here. **Express ships no frontend billing UI.** Purchasing lives entirely in the **frontend** Bridge plugin (the plan selector + Stripe Checkout) and in the Bridge API (Stripe webhooks that sync plan/subscription state). This guide covers two things only: (1) reading the current tenant's subscription, and (2) gating server behavior on what the tenant's plan sells — through flags ruled on plan features, and quotas for the numbers. Do not add purchasing, checkout URLs, or Stripe client code to the backend. It also documents how to **configure** the plans, prices and quotas you gate on — that is platform configuration done over MCP or the CLI, not code you write into the app.

Team/workspace management is likewise out of scope — the backend surface is read-only and exposes no team CRUD. Member management is driven from the frontend plugin and the Bridge API.

## Decide first — gating, reading, or configuring?

| What you are doing | Surface |
|---|---|
| Enforce a plan limit on the route that creates the thing | `bridge.requireQuota(metric)` — see **Plan limits** |
| Keep a count of things that exist in step after a delete | `bridge.syncQuota(metric, { current })` |
| Refuse a route unless the tenant's plan includes a feature | `bridge.protect({ featureFlag: '<feature>' })`, the flag ruled `bridge:billing.entitlement.<feature> eq true` — see **Plan features are flags** |
| Refuse a whole path unless the plan includes a feature | `featureFlag: '<feature>'` on a route rule in `createBridge()`, same flag rule |
| Read the tenant's plan, status, user or branding | `bridge.fromRequest(req).subscription` / `.user` / `.branding` |
| Check or record a limit by hand (bulk jobs, mid-handler) | `bridge.quota` — `assertQuota`, `check`, `record`, `sync` |
| Meter usage, or read the live quota, at the lowest level | `tenant.usage.report(metric, n, key)` / `tenant.usage.set(metric, count)` / `tenant.usage.quota(metric)` |
| Create the plans, prices and quotas you gate on | **Not code.** MCP tools or the `bridge` CLI — see **Configuring plans** |
| Connect Stripe so any of it bills | **Not code.** `connect_stripe` / `setup_payments` (MCP) or `bridge stripe connect` (CLI) |
| Sell something — checkout, plan selector, Stripe redirect | **Not here at all.** Frontend plugin + Bridge API |

**Gate on what a plan sells, never on the plan's name.** List the feature on the plans that sell it (`bridge plan feature add <plan> <feature>`) and rule the flag on `bridge:billing.entitlement.<feature> eq true`. A feature key survives a plan rename and a new plan; a plan name does not.

## Prerequisites

1. `@nebulr-group/bridge-express` installed and `createBridge()` called at startup (see `integration-prompt.md`). `appId` / `apiBaseUrl` come from `BRIDGE_APP_ID` / `BRIDGE_API_BASE_URL` when you leave them out.
2. Plans and Stripe are already configured on the Bridge app (done in the frontend/master billing flow). Confirm with `list_plans` (MCP) or `bridge plan list` (CLI) — at least one plan should exist.
3. Routes are protected — flags and quotas are evaluated for a verified user JWT, so the caller must be authenticated (`bridge.auth()` or `bridge.protect()` in front).

> **Check Stripe is connected before configuring anything.** If it isn't, nothing you configure will bill.
>
> | Channel | Read status | Connect |
> |---|---|---|
> | MCP | `get_stripe_status` | `connect_stripe`, or `setup_payments` for the whole flow |
> | CLI | `bridge stripe status` | `bridge stripe connect --secret-key <sk_…> --publishable-key <pk_…>` |
>
> Connecting means handing over a live Stripe secret key. Ask the user for it — never invent one, and never read it out of a file you happened to find. If they would rather not paste a secret into a chat, the dashboard is the third option.

## Configuring plans — MCP, CLI, or dashboard

Plans, prices and quotas are **platform configuration**, not application code. Bridge exposes them over **two channels an agent can drive**, both hitting the same management API, so the result is identical:

| Operation | MCP tool | CLI |
|---|---|---|
| List plans (with prices + quotas) | `list_plans` | `bridge plan list` |
| Inspect one plan | `get_plan` | `bridge plan get <key>` |
| Create a plan | `create_plan` | `bridge plan create --key <k> --name <n>` |
| Rename / re-describe a plan | `update_plan` | `bridge plan update --key <k> --name <n>` |
| Add or replace a recurring price | `set_plan_price` | `bridge plan price set <key> --amount <n> --interval <i>` |
| Remove a price | `remove_plan_price` | `bridge plan price rm <key> --interval <i>` |
| Add or replace a usage quota | `set_plan_quota` | `bridge plan quota set <key> --metric <m> --limit <n> --policy <p> [--kind counter\|gauge]` |
| Remove a quota | `remove_plan_quota` | `bridge plan quota rm <key> --metric <m>` |
| List a plan's quotas | `list_plan_quotas` | `bridge plan quota list <key>` |
| Check Stripe is connected | `get_stripe_status` | `bridge stripe status` |
| **Connect Stripe** | `connect_stripe`, or `setup_payments` for the whole flow | `bridge stripe connect` |

**Use whichever you actually have.** If the user asked for a specific one, use that one. If you have both and the user expressed no preference, either is correct; pick one and stay on it for the whole task.

The **dashboard is a last resort**: only walk the user through the UI when neither MCP nor CLI is available *and* they don't want to install one — or when the user would rather not paste a live Stripe secret key into a chat.

### The common shape: free hard cap + premium metered overage

Two `set_plan_quota` calls on the same metric, differing only in `policy`:

```jsonc
// Free — requests past the cap are refused.
{ "key": "free",    "metric": "api_calls", "limit": 1000,  "policy": "hard" }

// Premium — 50k included, everything beyond it billed per unit through Stripe.
{ "key": "premium", "metric": "api_calls", "limit": 50000, "policy": "metered", "priceAmount": 0.002 }
```

`limit` is the number of included units — a hard ceiling under `policy: "hard"`, and the free allowance before per-unit billing kicks in under `"metered"` (`limit: 0` bills from the first unit). `priceAmount` must be `> 0` for `metered` and must **not** be set for `hard`. `priceCurrency` is optional: it defaults to the plan's price currency when that is unambiguous, so add a price to the plan (`set_plan_price`) before adding a metered quota. Same thing on the CLI: `bridge plan quota set premium --metric api_calls --limit 50000 --policy metered --price-amount 0.002`.

## Plan limits — one middleware on the route that creates the thing

The server is authoritative; the frontend's quota display is decoration. Anyone can call your API directly, so the limit lives on the route. One middleware checks the limit before the handler runs and records usage after it succeeds — there is nothing else to wire, and a curl call is refused exactly like a click.

Decide one thing per metric: **if deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.**

| | Counter | Gauge |
|---|---|---|
| Is… | something that **happened** — an export, an API call, an AI completion | something that **exists** — tickets, projects, stored files |
| Who counts | Bridge, from the events you report; resets each billing period | **Your app** — you pass `current`; never resets |
| Quota config | `--kind counter` (the default) | `--kind gauge` |
| Middleware | `bridge.requireQuota('exports')` | `bridge.requireQuota('tickets', { current })` on create, `bridge.syncQuota('tickets', { current })` on delete |

```ts
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';
import { tickets } from './tickets';

const bridge = createBridge(); // BRIDGE_APP_ID / BRIDGE_API_BASE_URL from the environment
const app = express();
app.use(express.json());
app.use(bridge.auth());

// Gauge: refused with 402 when the app already has `limit` tickets; after a
// 2xx the plugin sets Bridge's copy of the count.
app.post(
  '/tickets',
  bridge.requireQuota('tickets', { current: (t) => tickets.countFor(t.id) }),
  async (req, res) => {
    res.status(201).json(await tickets.create(req.bridgeTenant!.id, req.body));
  },
);

// No check; after a 2xx the gauge is set to the new, lower count.
app.delete(
  '/tickets/:id',
  bridge.syncQuota('tickets', { current: (t) => tickets.countFor(t.id) }),
  async (req, res) => {
    res.json(await tickets.remove(req.bridgeTenant!.id, req.params.id));
  },
);

// Counter: Bridge's tally is compared; one event is reported after a 2xx.
// Who may export is a flag (rule: bridge:billing.entitlement.data_export eq true);
// how many is the quota.
app.post(
  '/tickets/:id/export',
  bridge.protect({ featureFlag: 'data_export' }),
  bridge.requireQuota('exports'),
  async (req, res) => {
    res.json(await tickets.export(req.params.id));
  },
);
```

`current` receives a `QuotaTenant` (`t.id` is the verified workspace id, `t.userId`, `t.scope` the full `TenantScope`, `t.request`) and the Express `req`. Return your own count — it is what the limit is compared against, so it heals itself if Bridge's copy ever missed an update. There is no decrement and no reservation: every create and delete sends the whole current count.

**What happens, exactly:**

- **Before the handler:** the flag check first (402 `FEATURE_NOT_IN_PLAN` / 403), then the quota (402). A `metered` quota never refuses — past its allowance it bills. A metric with no quota on the plan is unlimited.
- **After the handler:** only when the response is **2xx**. A handler that throws, or answers 4xx/5xx, records nothing. **Exactly one write** to Bridge per metric: a gauge `PUT` or a counter event. The write is made when the handler ends the response and before the response is released, so a client that re-reads its usage right after the 2xx sees the new count.
- **Idempotency:** a counter is keyed by the request's `Idempotency-Key` header. The same key from the same workspace for the same metric is one event, however often the client retries (the key sent to Bridge is scoped to the verified workspace and metric, then hashed). Without the header, every successful request counts.
- **Needs a verified user.** Put `bridge.auth()` or `bridge.protect()` in front. A public route or an API-token-only caller has no workspace and gets 401.
- **Fail-closed:** if Bridge cannot answer the quota read, the request is refused with 503 — never let through unchecked.

**The refusal the frontend reads** — 402 Payment Required:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "Your plan allows 5 tickets; 5 are in use.",
  "metric": "tickets", "used": 5, "limit": 5, "fix": "/subscription" }
```

and for a flag whose rule asks for a plan feature the workspace's plan lacks, 402 `FEATURE_NOT_IN_PLAN` naming the flag and the same `fix`. `fix` is your subscription page; change it with `createBridge({ billing: { manageRoute: '/account/billing' } })`.

> **Every hard quota is also an entitlement** with the same name (dots become `_`), true while `used < limit`. So rule a flag on a feature key, never on the metric you also put `requireQuota` on: at the cap the flag would refuse before the quota can answer the 402 your frontend knows how to upsell. A flag for who may, `requireQuota` for how many.

> **Seats** are a plan limit the app names, e.g. `seats`: a gauge counted from membership (`bridge plan quota set pro --metric seats --limit 5 --policy hard --kind gauge --source membership`). Bridge counts the workspace's active members, pending invites included, so the app passes no count. When invites go through your own route, `bridge.requireQuota('seats')` on it refuses at the limit and writes nothing. Bridge's own invite API does not refuse at the limit.

> **A plan feature** is listed on the plans that sell it (`bridge plan feature add pro analytics`), which makes `bridge:billing.entitlement.analytics` true on `pro` and false elsewhere. Gate it with a flag `analytics` ruled `bridge:billing.entitlement.analytics eq true` and `bridge.protect({ featureFlag: 'analytics' })`. `app_active` is always present: true while the subscription is active, trialing, past due or cancelling at period end.

### Without middleware — `bridge.quota`

Everything the middleware does is a plain call on `bridge.quota` (a `BridgeQuotaService`), for bulk operations, workers, or a check in the middle of a handler. Refusals are thrown as a `BridgeRefusalError` (`QuotaExceededError`, `EntitlementRequiredError`) carrying `status` and `body`:

```ts
import { BridgeRefusalError, QuotaExceededError } from '@nebulr-group/bridge-express';

app.post('/tickets/import', async (req, res) => {
  try {
    const tenantId = bridge.quota.tenantIdFor(req); // the verified workspace id
    const have = await tickets.countFor(tenantId);
    const d = await bridge.quota.check(req, 'tickets', { current: have + req.body.rows.length - 1 });
    if (!d.allowed) throw new QuotaExceededError(bridge.quota.quotaExceededBody('tickets', have, d.limit!));
    await tickets.insertMany(tenantId, req.body.rows);
    await bridge.quota.sync(req, 'tickets', () => tickets.countFor(tenantId)); // one PUT
    res.status(201).end();
  } catch (e) {
    if (e instanceof BridgeRefusalError) return res.status(e.status).json(e.body);
    throw e;
  }
});
```

| Call | Does |
|---|---|
| `check(req, metric, { current? })` | Decides without refusing → `{ allowed, used, limit, quota }` |
| `assertQuota(req, metric, { current? })` | Throws the 402 above |
| `record(req, metric, { current? \| value?, idempotencyKey? })` | One write: gauge set, or counter event. Never throws |
| `sync(req, metric, current)` | Sets the gauge — what `bridge.syncQuota` does |

At the lowest level, `bridge.fromRequest(req).usage` has `quota(metric)`, `report(metric, n, key)` and `set(metric, count)`.

## Plan features are flags

Whole paths and single routes are gated the same way: by a flag whose rule names the plan feature.

1. List the feature on the plans that sell it: `bridge plan feature add pro reports` (and `enterprise`, …).
2. Create the flag `reports` with the rule `bridge:billing.entitlement.reports eq true` (see `feature-flags-prompt.md`).
3. Ask the flag — on a route with `bridge.protect({ featureFlag: 'reports' })`, or on a whole path with a route rule:

```ts
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
      { path: '/exports/*', privilege: 'AUTHENTICATED', featureFlag: 'data_export' },
    ],
  },
});

app.use(bridge.auth());
```

A caller whose plan does not include the feature is refused before the handler runs with **402 `FEATURE_NOT_IN_PLAN`**, naming the flag and the `fix` route, so the frontend can upsell. A flag that cannot be evaluated denies (fail-closed). A rule's `privilege` is only `'ANONYMOUS'` or `'AUTHENTICATED'`; the older `plans` / `entitlement` / `entitlements` fields on route rules and on `bridge.protect()` were removed, and a config that still passes one fails at startup naming the flag to use.

Moving a feature to another plan is then `bridge plan feature add` / `rm`, with no release.

### `bridge.fromRequest(req)` — the tenant behind the request

`bridge.fromRequest(req)` is the server-side counterpart of the frontend `bridge` object: on a route behind `bridge.auth()` / `bridge.protect()` it returns a request-scoped `TenantScope` for the tenant of the user the middleware verified. The scope fetches `GET {apiBaseUrl}/session/init` **once** (forwarding the verified JWT as `Authorization: Bearer` plus the `x-app-id` header) and caches the result via auth-core's pull cache (~30s TTL), so all slices share a single round-trip.

**Never read the raw `Authorization` header yourself.** `bridge.fromRequest(req)` only accepts a token the auth middleware verified on that request; it throws on a route without one. `bridge.fromJwt(token)` exists for a token you hold some other way.

> `bridge.tenant(tenantId)` (arbitrary tenant for cron/admin) is **not yet wired** and throws a clear error — don't use it.

## Reading subscription state

`TenantScope` exposes lazy, promise-returning slices off the single cached snapshot:

```ts
const tenant = bridge.fromRequest(req);

const sub = await tenant.subscription;
// SubscriptionSnapshot:
//   sub.plan.slug   — e.g. 'pro'
//   sub.plan.name   — e.g. 'Pro'
//   sub.status      — e.g. 'active' | 'trialing' | 'canceled' (string)
//   sub.endsAt?     — ISO timestamp when the subscription ends (optional)
//   sub.gateEngaged? — true when access is currently gated by billing state

const user = await tenant.user;         // { id, email?, role, tenantId }
const branding = await tenant.branding; // { logo, name, primaryButtonBgColor?, ... }
```

### Usage by hand

`bridge.requireQuota` covers the usual case. When you report usage yourself — a metered quantity that is not one-per-request, say — the tenant scope has the raw calls:

```ts
// Report a usage event for the current tenant (idempotency-keyed, best-effort).
await tenant.usage.report('api_calls');     // value defaults to 1
await tenant.usage.report('tokens', 1375);  // report N units

// Set a gauge to how many exist right now (rejects on failure; no decrement).
await tenant.usage.set('projects', await projects.countFor(tenantId));

// Read the live quota snapshot (includes metered overage estimate).
const q = await tenant.usage.quota('api_calls');
// q?.policy ('hard' | 'metered'), q?.kind ('counter' | 'gauge'); for metered: q.unitAmount, q.currency,
// q.overageEstimate, q.overcap. null when no quota is configured for the metric.
```

Count usage once, where the action happens: an action that calls this backend is counted here, and the frontend then reports nothing for it (outside production, a counting response carries `X-Bridge-Usage-Counted: <metric>` and bridge-svelte warns in development when the page reports the same metric). An action that never reaches a server is counted by the frontend plugin — that is first-class, and it trusts the browser. The per-unit **price** is configuration (`set_plan_quota` with `policy: "metered"` and `priceAmount`, or `bridge plan quota set <key> --policy metered --price-amount <n>`); the Bridge API meters and bills it through Stripe. Do not add Stripe code here.

#### Do not build a `/quota` endpoint for your frontend

| | |
|---|---|
| **Your backend** | Enforces the cap and records usage — `bridge.requireQuota` / `bridge.syncQuota`, or `bridge.quota` by hand. |
| **The frontend** | Reads quota **directly from Bridge** — `useQuota(metric)` in bridge-svelte, or the ready-made `<BridgeQuotaBanner metric="…" />` — and opens its upgrade dialog on your `402` by itself. |

So your API does **not** need a route that relays a `QuotaSnapshot` to your own UI, and your frontend should not hand-copy the `QuotaSnapshot` shape into a local type — the client SDK already returns it typed.

#### `hard` and `metered` behave oppositely

`hard` blocks at the limit. `metered` **never** blocks — units above `limit` bill per unit, so refusing the action on a metered plan means refusing money the customer already agreed to spend. Branch on `policy`, never on `remaining` alone.

When you meter by hand, pass a stable **idempotency key** as the third argument (`usage.report(metric, 1, entityId)`) so a retried request cannot double-bill. `bridge.requireQuota` does this for you from the `Idempotency-Key` request header.

Example — surface plan and lifecycle to the client:

```ts
app.get('/billing/status', bridge.protect(), async (req, res) => {
  const sub = await bridge.fromRequest(req).subscription;
  res.json({
    plan: sub.plan.slug,
    status: sub.status,
    endsAt: sub.endsAt ?? null,
    gated: sub.gateEngaged ?? false,
  });
});
```

## Invalidating after a change

The snapshot is cached for the TTL. After an action that you know changes plan state in the same request (rare on the backend — usually a Stripe webhook on the Bridge API drives this), force a refresh on next access:

```ts
const tenant = bridge.fromRequest(req);
tenant.invalidate();           // drops the cached snapshot
const fresh = await tenant.subscription;
```

Normally you don't call this — the ~30s TTL keeps state fresh. To react to billing changes as they happen, subscribe to Bridge **webhooks** (handled on a public route) rather than polling.

## Exceptions — a direct plan-feature check

Only when the developer explicitly asks for no flag. `bridge.requireEntitlement('<feature>')` on a route refuses with 403 `ENTITLEMENT_REQUIRED` unless the plan includes the feature:

```json
{ "statusCode": 403, "code": "ENTITLEMENT_REQUIRED", "message": "Your plan does not include 'pdf'.",
  "entitlement": "pdf", "fix": "/subscription" }
```

In a service or worker, `bridge.quota.assertEntitlement(req, '<feature>')` does the same, and `bridge.fromRequest(req).entitlements.can('<feature>')` answers a boolean (fail-closed: an unknown key is `false`). `bridge.requireEntitlement` logs a one-time note in development naming the flag to use instead. Never pair it with `bridge.requireQuota` on the same metric.

## Checklist

- [ ] `list_plans` / `bridge plan list` returns at least one plan (plans configured via the frontend/master billing flow)
- [ ] Stripe is connected on the app — `get_stripe_status` (MCP) or `bridge stripe status` (CLI); if it isn't, `connect_stripe` / `setup_payments` or `bridge stripe connect` does it, with keys the user supplies
- [ ] No checkout / paywall / Stripe client code added to the backend — purchasing stays in the frontend + Bridge API
- [ ] Every route that creates a limited thing carries `bridge.requireQuota(metric)` — with `current` for a gauge
- [ ] Every route that deletes a gauge-counted thing carries `bridge.syncQuota(metric, { current })`
- [ ] Every plan-feature gate is a flag ruled `bridge:billing.entitlement.<feature> eq true` — `bridge.protect({ featureFlag })` on the route or `featureFlag` on a route rule; no plan name compared anywhere
- [ ] No flag ruled on a metric that also carries `bridge.requireQuota`
- [ ] `npx @nebulr-group/bridge-cli check gates` reports nothing
- [ ] No handler reads the raw `Authorization` header — `bridge.fromRequest(req)` behind the auth middleware
- [ ] `bridge.tenant(tenantId)` is NOT used (not yet wired)

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Limit (gauge):** with a `tickets` hard limit of N, the (N+1)th `POST` — sent with curl, not through the UI — answers 402 `QUOTA_EXCEEDED` with `used`/`limit`/`fix`; after a `DELETE`, `GET /v1/usage/quota/tickets` on Bridge shows `used` one lower and a create succeeds again.
3. **Limit (counter):** two requests with the same `Idempotency-Key` raise Bridge's `used` by one; a request that fails (4xx/5xx) raises it by none.
4. **Plan-feature gate:** a tenant whose plan does not list `reports` gets 402 `FEATURE_NOT_IN_PLAN` from a `featureFlag: 'reports'` route; after `bridge plan feature add <its plan> reports` it gets 200, with no release.
5. **Subscription read:** `GET /billing/status` returns the tenant's current `plan`, `status`, and `endsAt` matching the dashboard.
6. **Fail-closed:** a flag that does not exist is off, so its route is refused, not opened.
