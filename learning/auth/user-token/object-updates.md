---
title: How the token is kept current
description: There's no live push on the server — what "current" means for each piece of data bridge-express reads, and how to react to changes.
sidebar:
  label: Express
---

# How the token is kept current

A frontend Bridge SDK holds a live channel open and pushes role/plan/permission changes down to the app in place. An Express backend has no equivalent open connection to a browser tab — every request is its own independent verification, and there's nothing to "push" into. What "current" means here differs by exactly which piece of data you're reading, so it's worth separating out:

## The JWT claims (`req.bridgeUser`, `req.bridgeTenant`) — as current as the token itself

`role`, `privileges`, and the tenant claims all come straight out of the JWT the middleware just verified — there's no server-side cache of "this user's role" that could go stale between your reads. The moment a request carries a token, whatever's baked into that token is authoritative for that request, full stop.

The catch: a JWT is only re-issued when the *frontend* refreshes it, not on some schedule your backend controls. If an admin changes a user's role while that user already holds a valid, unexpired access token, requests bearing the old token will keep showing the old role until:

- the token naturally expires and the client refreshes (access tokens are short-lived by design, so this is usually minutes, not hours), or
- the client is otherwise forced to fetch a new token (e.g. after a `403` your frontend interprets as "state changed, refetch").

Your Express app has no way to force that refresh from the server side — there's no revocation list for user JWTs (see [Logging in and logging out](/auth/user-token/logging-in-and-out/)). If you need a role/privilege change to take effect *immediately*, regardless of what token a caller is still holding, put the check behind something the server does control — an API-token privilege (instantly revocable via introspection) or your own database lookup — rather than relying solely on JWT claims.

## The JWKS keyset and API-token introspection — cached, independently

Two different caches sit under the two verification paths, and they're tuned for opposite goals:

| What | Cache | Why |
|---|---|---|
| JWKS keyset (user-JWT signature verification) | ~1 hour, refreshed lazily | Signing keys rotate rarely; re-fetching them every request would be wasted network calls for data that almost never changes. |
| API-token introspection result | `introspectionCacheTtlMs`, default `0` (disabled) | API tokens are the one credential type with real, expected revocation — the default trades zero caching for instant revocation. Raise `introspectionCacheTtlMs` only if you've measured introspection latency as a real cost and can accept slower revocation. |

Neither cache affects how fresh `req.bridgeUser`/`req.bridgeApiToken` are for a given request — they only affect how the *verification itself* is performed. See [Configuration](/auth/config/) for how to set `introspectionCacheTtlMs`.

## Tenant data beyond the JWT (`bridge.fromJwt(...)`) — pull, not push

Subscription, entitlements, and branding aren't in the JWT at all — `bridge.fromJwt(req.bridgeAccessToken!)` fetches them over REST (`GET /session/init`) and caches the result briefly (~30s default) so concurrent requests for the same user share one round-trip:

```typescript
const tenant = bridge.fromJwt(req.bridgeAccessToken!);
const sub = await tenant.subscription; // may be up to ~30s stale
```

Right after a mutation that affects this data — you just upgraded the tenant's plan — call `invalidate()` so the next read is forced fresh instead of serving the stale cached snapshot:

```typescript
await upgradePlan(tenantId, 'pro');
tenant.invalidate();
const fresh = await tenant.subscription; // re-fetched
```

There is no live server-side channel for this data either — see [Tenant Data](../bridge-service/bridge-service.md) for the full `bridge.fromJwt()` reference.

## Reacting to a change without polling: webhooks

If your Express app needs to *do something* the moment a tenant or user changes server-side (provision a resource, invalidate your own cache, send a notification), don't poll `bridge.fromJwt(...)` — handle Bridge's webhooks instead. See [Multi-tenancy](/auth/multi-tenancy/multi-tenancy/) for the event types and a public webhook-handling route.
