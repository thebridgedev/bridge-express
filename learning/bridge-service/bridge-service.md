# Reading tenant data with `bridge.fromJwt()`

`bridge.fromJwt(userJwt)` gives a request handler one place to read everything Bridge knows about the **current request's tenant**: its subscription, entitlements, branding, and user — without hand-rolling REST calls to the Bridge API.

Two things to know:

1. **It reads on demand and caches.** Each tenant's data is fetched over REST (`GET /session/init`) and cached briefly. There are no push updates on the server — to react to a change (e.g. a plan upgrade), use Bridge **webhooks**.
2. **It's per request.** Every request carries a different tenant. You pass the incoming user's JWT and get back a scope bound to *that* user's tenant.

## Setup

There's nothing to wire — `fromJwt` is a method on the `bridge` instance you already created with `createBridge(...)`. Just call it inside a handler with the request's access token.

```typescript
import { Router } from 'express';

const router = Router();

router.get('/reports/export', async (req, res) => {
  const tenant = bridge.fromJwt(req.bridgeAccessToken!);

  if (!(await tenant.entitlements.can('pdf-export'))) {
    res.status(403).json({ error: 'Forbidden', message: 'Your plan does not include PDF export' });
    return;
  }

  res.json(await buildExport());
});

export default router;
```

`req.bridgeAccessToken` is the raw user JWT, populated by the auth middleware once the route authenticates. The route must be authenticated (via `bridge.auth()` rules or `bridge.protect(...)`) for the token to be present.

## `bridge.fromJwt(userJwt)`

`fromJwt` takes the raw user JWT and returns a `TenantScope`. The JWT is forwarded to the Bridge API on the data fetch; the API derives the tenant from the token and returns the matching data. Concurrent calls for the same user are deduped onto a single round-trip.

> `bridge.tenant(tenantId)` — for accessing an arbitrary tenant from cron/admin code — is **not yet available** and throws a clear error if called. Use `bridge.fromJwt(userJwt)` from a request handler.

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
| `canSync(key, cached): boolean` | Synchronous check against an already-loaded map — pass the result of a prior `snapshot()`. Use when checking many keys in a hot path. |

```typescript
// Many checks without re-awaiting each time:
const ents = await tenant.entitlements.snapshot();
const canExport = tenant.entitlements.canSync('pdf-export', ents);
const canBulk   = tenant.entitlements.canSync('bulk-import', ents);
```

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

Useful for server-rendered emails or PDFs that should carry the tenant's branding.

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

Force the next access to re-fetch — call this right after a change that affects the data (e.g. you just upgraded the plan and want the fresh subscription):

```typescript
await upgradePlan(tenantId, 'pro');
tenant.invalidate();
const fresh = await tenant.subscription; // re-fetched
```

## Gating features by subscription

Reading the subscription and checking entitlements is how you enforce paid features server-side — there is no checkout or paywall in a backend plugin. Purchase and upgrade flows live in your frontend and in the Bridge API (webhooks drive the subscription lifecycle). Two ways to enforce:

**Declarative** — gate a route by plan in the central rules (see [Configuration](../configuration/configuration.md)):

```typescript
const bridge = createBridge({
  appId,
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
    ],
  },
});
```

**Programmatic** — gate inside a handler with an entitlement check:

```typescript
router.get('/features/export', async (req, res) => {
  const tenant = bridge.fromJwt(req.bridgeAccessToken!);
  if (!(await tenant.entitlements.can('export'))) {
    res.status(403).json({ error: 'Forbidden', message: "Entitlement 'export' required" });
    return;
  }
  res.json({ subscription: await tenant.subscription });
});
```

## Caching notes

- Default cache lifetime is **~30s**. Concurrent callers for the same user share one in-flight fetch.
- The cache is a pull cache: there is no live server-side channel. To react to a billing change (a plan upgrade, a cancellation), use Bridge **webhooks** rather than polling.

## See also

- [Configuration](../configuration/configuration.md) — `plans` route rules
- [Feature Flags](../feature-flags/feature-flags.md) — flag-based gating (distinct from entitlements)
- [Multi-Tenancy](../multi-tenancy/multi-tenancy.md) — tenant context fundamentals
