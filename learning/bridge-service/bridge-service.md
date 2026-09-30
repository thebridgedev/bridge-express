# Reading tenant data with `bridge.fromRequest()`

`bridge.fromRequest(req)` gives a request handler one place to read everything Bridge knows about the **current request's workspace** (called a *tenant* in the API): its subscription, entitlements, usage, branding, and user, without hand-rolling REST calls to the Bridge API.

Two things to know:

1. **It reads on demand and caches.** Each workspace's data is fetched over REST (`GET /session/init`) and cached briefly. There are no push updates on the server; to react to a change (e.g. a plan upgrade), use Bridge **webhooks**.
2. **It's per request.** Every request carries a different workspace. You pass the request and get back a scope bound to the workspace of the user the auth middleware verified on it.

## Setup

There's nothing to wire: `fromRequest` is a method on the `bridge` instance you already created with `createBridge(...)`. Call it inside a handler behind `bridge.auth()` or `bridge.protect()`.

```typescript
import { Router } from 'express';

const router = Router();

router.get('/billing/status', async (req, res) => {
  const sub = await bridge.fromRequest(req).subscription;
  res.json({ plan: sub.plan.slug, status: sub.status, endsAt: sub.endsAt ?? null });
});

export default router;
```

`fromRequest` only accepts a user token the auth middleware verified on this request; on a public route, a route without `bridge.auth()` / `bridge.protect()` in front, or an API-token-only caller it throws. It never reads a header or `req.bridgeAccessToken` (which any other middleware could set) in its place.

## `bridge.fromJwt(userJwt)`

For a token you hold some other way, `fromJwt` takes the raw user JWT and returns the same `TenantScope`. The JWT is forwarded to the Bridge API on the data fetch; the API derives the workspace from the token and returns the matching data. Concurrent calls for the same user are deduped onto a single round-trip.

> `bridge.tenant(tenantId)`, for accessing an arbitrary workspace from cron/admin code, is **not yet available** and throws a clear error if called. Use `bridge.fromRequest(req)` from a request handler.

## What you can read

The first access to any field triggers one fetch that returns subscription + entitlements + branding + user together. The result is cached (default **~30s**); concurrent callers share the in-flight fetch. Every field below resolves lazily off that single fetch.

```typescript
interface SessionSnapshotData {
  app: { branding: BrandingSnapshot };
  tenant: {
    id: string;
    name: string;
    subscription: SubscriptionSnapshot;
    entitlements: Record<string, boolean>;
  };
  user: UserSnapshot;
}
```

### `tenant.subscription` → `Promise<SubscriptionSnapshot>`

```typescript
interface SubscriptionSnapshot {
  plan: { slug: string; name: string };
  status: string;        // e.g. 'active', 'trialing', 'canceled'
  endsAt?: string;
  gateEngaged?: boolean;  // true when the plan gate is currently blocking the tenant
}

const sub = await tenant.subscription;
if (sub.plan.slug === 'free') { /* ... */ }
```

### `tenant.entitlements`

The common path is `.can(key)`:

```typescript
if (await tenant.entitlements.can('seats:10')) { /* ... */ }
```

| Method | Behavior |
|---|---|
| `can(key): Promise<boolean>` | Loads the data if needed, then answers. The usual call. |
| `snapshot(): Promise<Record<string, boolean>>` | The full entitlements map; fetches on first call. |
| `canSync(key, cached): boolean` | Synchronous check against an already-loaded map; pass the result of a prior `snapshot()`. Use when checking many keys in a hot path. |

```typescript
// Many checks without re-awaiting each time:
const ents = await tenant.entitlements.snapshot();
const canExport = tenant.entitlements.canSync('pdf-export', ents);
const canBulk   = tenant.entitlements.canSync('bulk-import', ents);
```

### `tenant.usage`

The raw usage calls behind [plan limits](../plan-limits/plan-limits.md). `bridge.requireQuota` / `bridge.syncQuota` make them for you; call them yourself for a metered quantity that is not one-per-request.

| Method | Behavior |
|---|---|
| `quota(metric): Promise<QuotaSnapshot \| null>` | Live quota (`GET /usage/quota/:metric`): `used`, `limit`, `remaining`, `policy` (`hard` \| `metered`), `kind` (`counter` \| `gauge`). `null` when the plan sets none. |
| `report(metric, value = 1, idempotencyKey?)` | Report a counter event (`POST /usage/ingest`). Best-effort: never throws. |
| `set(metric, count)` | Set a gauge to how many exist right now (`PUT /usage/gauge/:metric`). Rejects on failure; no decrement. |

### `tenant.branding` → `Promise<BrandingSnapshot>`

```typescript
interface BrandingSnapshot {
  logo: string;
  name: string;
  primaryButtonBgColor?: string;
  textColor?: string;
  bgColor?: string;
  fontFamily?: string;
}
```

Useful for server-rendered emails or PDFs that should carry the workspace's branding.

### `tenant.user` → `Promise<UserSnapshot>`

```typescript
interface UserSnapshot {
  id: string;
  email?: string;
  role: string;
  tenantId: string;
}
```

### `tenant.invalidate()`

Force the next access to re-fetch. Call this right after a change that affects the data (e.g. you just upgraded the plan and want the fresh subscription):

```typescript
await upgradePlan(tenantId, 'pro');
tenant.invalidate();
const fresh = await tenant.subscription; // re-fetched
```

## Gating features by subscription

There is no checkout or paywall in a backend plugin; purchase and upgrade flows live in your frontend and in the Bridge API. What the backend enforces:

- **A yes/no a plan sells** is a flag: rule it `bridge:billing.entitlement.<feature> eq true` and put `bridge.protect({ featureFlag: '<feature>' })` on the route (or `featureFlag` on a route rule). A workspace without it gets `402 FEATURE_NOT_IN_PLAN`.
- **A number** is a plan limit: `bridge.requireQuota(metric)` — see [Plan limits](../plan-limits/plan-limits.md).

Reading `tenant.entitlements.can(key)` to decide access in app code is the exception, for when the developer explicitly asks for no flag; `bridge.requireEntitlement(key)` does it as middleware and answers `403 ENTITLEMENT_REQUIRED`.

## Caching notes

- Default cache lifetime is **~30s**. Concurrent callers for the same user share one in-flight fetch.
- The cache is a pull cache: there is no live server-side channel. To react to a billing change (a plan upgrade, a cancellation), use Bridge **webhooks** rather than polling.

## See also

- [Plan limits](../plan-limits/plan-limits.md): quotas as middleware
- [Configuration](../configuration/configuration.md): the full `RouteRule` reference
- [Feature Flags](../feature-flags/feature-flags.md): flag-based gating (distinct from entitlements)
- [Multi-Tenancy](../multi-tenancy/multi-tenancy.md): tenant context fundamentals
