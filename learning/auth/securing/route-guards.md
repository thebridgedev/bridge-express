---
title: Route guards
description: Global vs per-router vs per-route protection with bridge.auth() / bridge.protect(), plus centralized route rules.
sidebar:
  label: Express
---

# Route guards

Express has no built-in guard/interceptor system, so Bridge Express gives you three middleware factories off the single `bridge` instance: `bridge.auth()`, `bridge.protect(options?)`, and `bridge.public()`. They combine; most apps use all three.

## Declarative guard (recommended)

Mount `bridge.auth()` once, app-level. It reads the `guard` config you passed to `createBridge(...)` and applies `defaultAccess` plus your route rules to every route registered after it:

```typescript
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

// appId comes from BRIDGE_APP_ID when not passed
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
});

const app = express();
app.use(bridge.auth()); // every route registered below this line is governed by the rules above
```

With the declarative guard mounted, mark specific handlers public with `bridge.public()`:

```typescript
app.get('/health', bridge.public(), (_req, res) => {
  res.json({ status: 'ok' });
});
```

`bridge.public()` always wins: it sets `req.__bridgePublic = true`, and `bridge.auth()` checks that flag first, before consulting any route rule.

## Per-router / per-route guard

`bridge.protect(options?)` always enforces auth on the router or route it's attached to, regardless of `defaultAccess`. Its options **are** the rule, so it does not consult the config's `rules` at all:

```typescript
// Force auth on one route even if defaultAccess is 'public'
app.get('/secret', bridge.protect(), handler);
```

Mount it on a whole router to protect a group of routes in one line:

```typescript
import { Router } from 'express';

const admin = Router();
admin.use(bridge.protect({ featureFlag: 'admin-area' })); // rule: privileges contains "USER_WRITE"
admin.get('/dashboard', handler);
admin.get('/settings', bridge.protect({ featureFlag: 'admin-settings' }), handler);

app.use('/admin', admin);
```

Stacked `protect(...)` calls each run independently, so a request must pass every flag on its path. Who gets a route is always a flag; the flag's rule says why (a privilege, a plan feature, a rollout).

## What the guard checks, in order

1. **`bridge.public()` flag (`req.__bridgePublic`)**: if set, the request is allowed immediately, no matter what else is configured.
2. **Route rule with `privilege: 'ANONYMOUS'`**: same effect as `bridge.public()`, but centrally configured (see below).
3. **No matching rule + `defaultAccess: 'public'`**: allowed.
4. **Credential verification**: the `x-api-key` and/or `Authorization: Bearer` headers are verified independently. At least one valid credential is required past this point, or the request gets a `401`.
5. **API-token `privilege` option**: enforced against the API token's privileges, when an API token is present (`bridge.protect({ privilege })`). API tokens only.
6. **Feature flag**: `bridge.protect({ featureFlag })`, or the matching route rule's `featureFlag` under `bridge.auth()`, evaluated against the user's access token.

`privilege` is API tokens only; flags gate a signed-in person. See [How roles & privileges work](/auth/roles/how-it-works/) and [API tokens](/auth/api-tokens/) for exactly which credential each check applies to.

Plan limits (`bridge.requireQuota`, `bridge.syncQuota`) and the direct `bridge.requireEntitlement` check are separate middleware you put after `auth()`/`protect()`; see [Plan limits](../../plan-limits/plan-limits.md).

## Centralized route rules

Instead of scattering `bridge.protect(...)` across every router, list rules once in `guard.rules`. Each rule matches a REST path (wildcard `*` supported):

```typescript
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/api/status', privilege: 'AUTHENTICATED' },
      { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/account/subscription/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-billing' },
    ],
  },
});
```

| Rule field | Type | Description |
|---|---|---|
| `path` | `string` | REST URL wildcard pattern, e.g. `/account/subscription/*`. `*` matches any characters, including `/`. Matched against the request path only (not method). |
| `graphqlOperation` | `string` | GraphQL operation name. Present on the type for cross-framework parity, but **not wired** in the Express plugin; see below. |
| `privilege` | `'ANONYMOUS' \| 'AUTHENTICATED'` (required) | Whether the route needs a signed-in caller. |
| `featureFlag` | `string \| { any } \| { all }` | The flag that decides who gets the route; its rule says why (e.g. `privileges contains "USER_WRITE"`). |

Rules are matched in order; the first match wins. `protect()` never reads route rules; its options are the rule.

**Who gets a route is a flag**, set as `featureFlag` here or with `bridge.protect({ featureFlag })`. A rule that still carries a privilege key or the removed `plans` / `entitlement` / `role` options stops the app at startup with an error naming the flag setup to use. See [Configuration](/auth/config/) for the full `RouteRule` / `GuardConfig` reference.

> **GraphQL.** Express has no built-in GraphQL execution context the way a decorator-based framework does. Protect a `/graphql` route with `bridge.protect(...)` like any other route. The `graphqlOperation` rule field exists on the type but is not evaluated by the Express plugin; don't rely on per-operation GraphQL guarding here.

For anything that must be enforced, put the flag on the actual route; never rely on a check that only exists in a caller's UI. Run `npx @nebulr-group/bridge-cli check gates` before calling the work done.
