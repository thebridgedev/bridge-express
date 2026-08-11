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

const bridge = createBridge({
  appId: 'YOUR_APP_ID',
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
admin.use(bridge.protect({ role: 'ADMIN' })); // every route on this router requires ADMIN
admin.get('/dashboard', handler);
admin.get('/settings', handler);

app.use('/admin', admin);
```

One caveat when stacking `protect(...)` calls: each one runs independently, and the `role` check is an exact match against the single role in the user's token. Chaining a router-level `bridge.protect({ role: 'ADMIN' })` with a route-level `bridge.protect({ role: 'OWNER' })` therefore locks everyone out (no user is both `ADMIN` and `OWNER` in the same workspace, since a user has exactly one role per workspace, which is called a *tenant* in the API). Give each route a single `role` requirement, and put routes that need a different role on their own router or route.

## What the guard checks, in order

1. **`bridge.public()` flag (`req.__bridgePublic`)**: if set, the request is allowed immediately, no matter what else is configured.
2. **Route rule with `privilege: 'ANONYMOUS'`**: same effect as `bridge.public()`, but centrally configured (see below).
3. **No matching rule + `defaultAccess: 'public'`**: allowed.
4. **Credential verification**: the `x-api-key` and/or `Authorization: Bearer` headers are verified independently. At least one valid credential is required past this point, or the request gets a `401`.
5. **API-token `privilege` option**: enforced against the API token's privileges, when an API token is present (`bridge.protect({ privilege })`).
6. **Route-rule privilege** (anything beyond `ANONYMOUS`/`AUTHENTICATED`): enforced against the user JWT's `privileges`, when a user JWT is present. `protect()` skips this step entirely since it doesn't consult route rules.
7. **`role` option**: enforced against the user JWT's `role` (`bridge.protect({ role })`).
8. **`featureFlag` option**: enforced by evaluating the flag against the user's access token (`bridge.protect({ featureFlag })`).

Role and privilege checks are evaluated against **different credential types**. See [How roles & privileges work](/auth/roles/how-it-works/) for exactly which credential each check applies to, and [API tokens](/auth/api-tokens/) for the API-token auth flow in full.

## Centralized route rules

Instead of scattering `bridge.protect(...)` across every router, list rules once in `guard.rules`. Each rule matches a REST path (wildcard `*` supported):

```typescript
const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/api/status', privilege: 'AUTHENTICATED' },
      { path: '/users/*', privilege: 'USER_READ' },
      { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },
    ],
  },
});
```

| Rule field | Type | Description |
|---|---|---|
| `path` | `string` | REST URL wildcard pattern, e.g. `/account/subscription/*`. `*` matches any characters, including `/`. Matched against the request path only (not method). |
| `graphqlOperation` | `string` | GraphQL operation name. Present on the type for cross-framework parity, but **not wired** in the Express plugin; see below. |
| `privilege` | `RoutePrivilege` (required) | `'ANONYMOUS'`, `'AUTHENTICATED'`, one of the built-in privilege strings, or any custom string that must appear in the user JWT's `privileges` claim. |
| `plans` | `string[]` | Declared on the type but **not yet enforced** by the middleware; a rule's `plans` list is currently ignored. For plan gating that actually blocks requests, use entitlement checks via `bridge.fromJwt(...)` (see [Tenant Data](../../bridge-service/bridge-service.md)). |

Rules are matched in order; the first match wins. **Roles and feature flags are not part of route rules**; they're `bridge.protect(...)`-option-only. Route rules cover privilege-gating and public/anonymous access; see [Configuration](/auth/config/) for the full `RouteRule` / `GuardConfig` reference.

> **GraphQL.** Express has no built-in GraphQL execution context the way a decorator-based framework does. Protect a `/graphql` route with `bridge.protect(...)` like any other route. The `graphqlOperation` rule field exists on the type but is not evaluated by the Express plugin; don't rely on per-operation GraphQL guarding here.

For anything security-critical, enforce it here, in `bridge.auth()`/`bridge.protect(...)` on the actual route; never rely on a check that only exists in a caller's UI.
