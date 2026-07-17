---
title: Getting the user token
description: Reading the authenticated user, tenant, and raw token off a request in an Express backend.
sidebar:
  label: Express
---

# Getting the user token

There's no store to read and no token to fetch yourself. `bridge.auth()` / `bridge.protect(...)` verify the incoming `Authorization: Bearer` header (or `x-api-key`) and attach the decoded result to the Express `Request` before your handler runs. See [Route guards](/auth/securing/route-guards/) for when that happens in the request lifecycle.

## The recommended path: `req.bridgeUser` and `req.bridgeTenant`

```typescript
import { Router } from 'express';

const router = Router();

router.get('/items', (req, res) => {
  const user = req.bridgeUser!;
  const tenant = req.bridgeTenant;
  res.json({ requestedBy: user.email, tenant: tenant?.name });
});

export default router;
```

Bridge Express augments the Express `Request` type via declaration merging, so `req.bridgeUser`, `req.bridgeTenant`, `req.bridgeAccessToken`, and `req.bridgeApiToken` are all typed and available without extra setup. `req.bridgeUser` and `req.bridgeTenant` only ever hold a value on a **user JWT** request; an API-token-only request has neither set, since API tokens don't carry a user or workspace identity the same way (see [API tokens](/auth/api-tokens/)).

`BridgeUser` is populated straight off the verified JWT claims. There's no separate "minimal identity" vs. "full profile" split the way a frontend often has (one lean reactive object plus a richer profile fetch); this one object already carries everything decoded from the token:

| Field | Type | Description |
|-------|------|--------------|
| `id` | `string` | User ID (`sub` claim) |
| `email` | `string` | Email address |
| `emailVerified` | `boolean` | Email verification status |
| `username` | `string` | Username (`preferred_username`, falls back to email) |
| `fullName` | `string` | Full display name |
| `givenName` / `familyName` | `string \| undefined` | First / last name |
| `locale` | `string \| undefined` | User's locale |
| `onboarded` | `boolean \| undefined` | Whether onboarding is complete |
| `tenantId` | `string` | ID of the workspace this token was issued for (a workspace is called a *tenant* in the API) |
| `appId` | `string \| undefined` | App ID the token was issued for (`aid` claim) |
| `scope` | `string \| undefined` | OAuth scopes on the token |
| `role` | `string \| undefined` | User's role in this workspace |
| `privileges` | `string[] \| undefined` | Privilege keys from the JWT `privileges` claim |
| `multiTenantAccess` | `boolean \| undefined` | Whether the user can access more than one workspace |

`BridgeTenant` is similarly decoded from the token's tenant claims (`tid`/`tenant_id`, `tenant_name`, `tenant_locale`, `tenant_logo`, `tenant_onboarded`):

| Field | Type | Description |
|-------|------|--------------|
| `id` | `string` | Workspace (tenant) ID |
| `name` | `string` | Workspace name |
| `locale` | `string \| undefined` | Workspace locale preference |
| `logo` | `string \| undefined` | Workspace logo URL |
| `onboarded` | `boolean \| undefined` | Whether the workspace has completed onboarding |

If the token carries no tenant claim, `transformJwtToBridgeTenant` returns `null` and `req.bridgeTenant` is `undefined`.

## Reading the API-token path

`req.bridgeApiToken` is the counterpart on the machine-to-machine path, set when the request authenticated via `x-api-key` instead of (or alongside) a user JWT:

```typescript
router.get('/api/status', bridge.protect(), (req, res) => {
  res.json({
    user: req.bridgeUser,          // set on the user-JWT path
    apiToken: req.bridgeApiToken,  // set on the API-token path; see API tokens
  });
});
```

| Field | Type | Description |
|-------|------|--------------|
| `sub` | `string` | Token subject identifier |
| `appId` | `string` | App ID the token was issued for |
| `tenantId` | `string \| null` | Workspace (tenant) ID; `null` for app-level tokens |
| `type` | `'api'` | Always `'api'` for API tokens |
| `privileges` | `string[]` | Privilege strings (e.g. `['USER_READ', 'TENANT_WRITE']`) |
| `exp` | `number \| undefined` | Expiry (epoch seconds) |

Both a user JWT and an API token can be present and valid on the same request at once; see [API tokens](/auth/api-tokens/) for dual-credential requests.

## The raw access token: `req.bridgeAccessToken`

You almost never need this either, but when your handler needs to call another Bridge-aware backend on the caller's behalf (a downstream service, or Bridge's own API), forward the verified token instead of re-deriving credentials:

```typescript
router.get('/items/from-service-b', async (req, res) => {
  const data = await bridge.http.get('http://service-b/items', req.bridgeAccessToken);
  res.json(data);
});
```

`req.bridgeAccessToken` is only set on the user-JWT path (it's the exact bearer token the middleware just verified). This is the backend counterpart to a frontend `tokenStore`, except there's no refreshing to think about: your handler only ever sees a token that has already been validated for *this* request, and you're not responsible for its lifetime.

## Tenant-scoped data beyond the JWT: `bridge.fromJwt()`

`req.bridgeTenant` only gives you what's baked into the JWT (id, name, locale, logo, onboarded). For subscription plan, entitlements, or branding, use `bridge.fromJwt(req.bridgeAccessToken!)`, which fetches (and short-TTL-caches) a fuller snapshot for the token's workspace:

```typescript
router.get('/billing/plan', async (req, res) => {
  const tenant = bridge.fromJwt(req.bridgeAccessToken!);
  res.json(await tenant.subscription);
});
```

See [How the token is kept current](/auth/user-token/object-updates/) for how fresh this snapshot is relative to the JWT-decoded fields, and [Multi-tenancy](/auth/multi-tenancy/multi-tenancy/) for how tenant scoping is enforced.
