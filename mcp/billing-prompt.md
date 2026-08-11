# Bridge Express — Billing & Entitlements

You are adding **server-side billing enforcement** to an Express application that uses The Bridge.

> **What "billing" means on the backend.** A backend plugin **reads** subscription state and **enforces** entitlements — nothing more. There is no checkout, no paywall, no plan selector, and no Stripe redirect here. **Express ships no frontend billing UI** (the plan selector is a frontend plugin component, not part of bridge-express). Purchasing lives entirely in the **frontend** Bridge plugin (the plan selector + Stripe Checkout) and in the Bridge API (Stripe webhooks that sync plan/subscription state). This guide covers two things only: (1) reading the current tenant's subscription, and (2) gating server behavior on the tenant's plan and entitlements. Do not add purchasing, checkout URLs, or Stripe client code to the backend.

Team/workspace management is likewise out of scope — the backend surface is read-only and exposes no team CRUD. Member management is driven from the frontend plugin and the Bridge API.

## Prerequisites

1. `@nebulr-group/bridge-express` installed and `createBridge(config)` called at startup (see `integration-prompt.md`).
2. Plans and Stripe are already configured on the Bridge app (done in the frontend/master billing flow). Confirm with `bridge plan list` — at least one plan should exist.
3. Routes are protected — entitlement gating runs on a verified user JWT, so the caller must be authenticated.

## How backend enforcement works

There are two layers, declarative and programmatic. Use whichever fits.

| Layer | Where | Best for |
|---|---|---|
| **Declarative** — `plans: [...]` on a route rule | `createBridge` guard config | Whole paths gated by plan tier |
| **Programmatic** — `bridge.fromJwt(jwt).entitlements.can(key)` | Inside a handler | Fine-grained per-feature / per-action gates |

### Declarative — plan-restricted routes

Add `plans` to a route rule; the tenant's subscription plan must be in the list. Combine with a `privilege`:

```ts
const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
      { path: '/exports/*', privilege: 'TENANT_WRITE', plans: ['enterprise'] },
    ],
  },
});

app.use(bridge.auth());
```

A caller whose tenant is on `free` hits `/reports/...` and is rejected before the handler runs.

### Programmatic — `bridge.fromJwt(...)`

`bridge.fromJwt(userJwt)` is the server-side counterpart of the frontend `bridge` object. Pass the verified JWT (it's on `req.bridgeAccessToken` after the guard runs) to get a request-scoped `TenantScope` for the tenant that owns the JWT. The scope fetches `GET ${apiBaseUrl}/session/init` **once** (forwarding the JWT as `Authorization: Bearer` plus the `x-app-id` header) and caches the result via auth-core's pull cache (~30s TTL), deduping concurrent fetches, so all slices share a single round-trip.

```ts
import { Request, Response } from 'express';

app.get('/exports', bridge.protect(), async (req: Request, res: Response) => {
  const tenant = bridge.fromJwt(req.bridgeAccessToken!);

  if (!(await tenant.entitlements.can('data_export'))) {
    return res.status(403).json({ error: 'Forbidden', message: 'Your plan does not include data export.' });
  }

  return res.json(exportService.run());
});
```

> `bridge.fromJwt(userJwt)` is the supported path. `bridge.tenant(tenantId)` (arbitrary tenant for cron/admin) is **not yet wired** and throws a clear error pointing you back to `fromJwt` — don't use it.

The JWT passed to `fromJwt` is the raw token without the `Bearer ` prefix. `req.bridgeAccessToken` already holds it stripped, so just pass that through.

## Reading subscription state

`TenantScope` exposes lazy, promise-returning slices off the single cached snapshot:

```ts
const tenant = bridge.fromJwt(req.bridgeAccessToken!);

const sub = await tenant.subscription;
// SubscriptionSnapshot:
//   sub.plan.slug   — e.g. 'pro'
//   sub.plan.name   — e.g. 'Pro'
//   sub.status      — e.g. 'active' | 'trialing' | 'canceled' (string)
//   sub.endsAt?     — ISO timestamp when the subscription ends (optional)
//   sub.gateEngaged? — true when access is currently gated by billing state

const user = await tenant.user;        // { id, email?, role, tenantId }
const branding = await tenant.branding; // { logo, name, primaryButtonBgColor?, ... }
```

Example — surface plan and lifecycle to the client:

```ts
import { Request, Response } from 'express';

app.get('/billing/status', bridge.protect(), async (req: Request, res: Response) => {
  const sub = await bridge.fromJwt(req.bridgeAccessToken!).subscription;
  res.json({
    plan: sub.plan.slug,
    status: sub.status,
    endsAt: sub.endsAt ?? null,
    gated: sub.gateEngaged ?? false,
  });
});
```

## Reading entitlements

Entitlements are the granular "what can this tenant do" map, derived from the plan. `tenant.entitlements` gives you three accessors:

```ts
const ent = bridge.fromJwt(req.bridgeAccessToken!).entitlements;

// Common path — loads the snapshot if needed, then answers:
const canExport = await ent.can('data_export');         // Promise<boolean>

// Full map (also loads the snapshot on first call):
const all = await ent.snapshot();                        // Record<string, boolean>

// Synchronous check against an already-loaded map (no fetch):
const map = await ent.snapshot();
const canSeats = ent.canSync('extra_seats', map);        // boolean
```

`can(key)` and `snapshot()` are **fail-closed**: an unknown key returns `false`. Gate the feature, not just the route, when the same capability is reachable through multiple endpoints or background jobs:

```ts
async function complete(userJwt: string, prompt: string) {
  if (!(await bridge.fromJwt(userJwt).entitlements.can('ai_completions'))) {
    throw new Error('AI completions are not in your plan.');
  }
  return runModel(prompt);
}
```

## Invalidating after a change

The snapshot is cached for the TTL. After an action that you know changes plan or entitlement state in the same request (rare on the backend — usually a Stripe webhook on the Bridge API drives this), force a refresh on next access:

```ts
const tenant = bridge.fromJwt(req.bridgeAccessToken!);
tenant.invalidate();           // drops the cached snapshot
const fresh = await tenant.subscription;
```

Normally you don't call this — the ~30s TTL keeps state fresh.

## Reacting to billing events — webhooks

There is **no server-side live channel** in express. To react to billing changes (plan upgrades, cancellations, payment failures) as they happen, subscribe to Bridge **webhooks** (event-driven) rather than polling `subscription`. Handle the webhook on a public route (`privilege: 'ANONYMOUS'` or `bridge.public()`), and call `tenant.invalidate()` on the affected tenant's scope if you maintain one, so the next read reflects the change.

## Declarative vs programmatic — which to use

- Reach for **`plans` on a route rule** when an entire path is tier-gated and you can name the allowed plans up front.
- Reach for **`entitlements.can(key)`** when the gate is a named capability (not a plan slug), when the same capability is hit from several routes or a queue/cron worker, or when you want a precise 403 message. Entitlement keys are stable across plan renames; plan slugs are not.

## Checklist

- [ ] `bridge plan list` returns at least one plan (plans configured via the frontend/master billing flow)
- [ ] No checkout / paywall / Stripe client code added to the backend — purchasing stays in the frontend + Bridge API
- [ ] Tier-gated paths use `plans: [...]` on the route rule (with a `privilege`)
- [ ] Capability gates use `bridge.fromJwt(jwt).entitlements.can(key)` and fail closed
- [ ] `req.bridgeAccessToken` (already stripped of the `Bearer ` prefix) is what's passed to `fromJwt`
- [ ] `bridge.tenant(tenantId)` is NOT used (not yet wired)
- [ ] Subscription reads use the `subscription` slice (`plan.slug`, `status`, `endsAt`, `gateEngaged`)
- [ ] Event-driven billing reactions go through Bridge webhooks, not polling

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Plan gate (declarative):** a tenant on `free` calling a `plans: ['pro']` route gets rejected; a `pro` tenant gets 200.
3. **Entitlement gate (programmatic):** a tenant without the `data_export` entitlement gets 403 from the export endpoint; one with it gets 200.
4. **Subscription read:** `GET /billing/status` returns the tenant's current `plan`, `status`, and `endsAt` matching the dashboard.
5. **Fail-closed:** an unknown entitlement key resolves to `false` (the feature is denied), not an error.
