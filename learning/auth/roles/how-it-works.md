---
title: How roles & privileges work
description: The role/privilege model, and how it's enforced by the Bridge Express middleware.
sidebar:
  label: Express
---

# How roles & privileges work

A **role** is a named set of **privileges**: scoped permission keys like `USER_READ` or `TENANT_WRITE`. Every user is assigned exactly one role per workspace (called a *tenant* in the API); the role determines what that user can do in that workspace.

Roles are fully custom to your app; you're not stuck with a fixed enum. Every app starts with:

- **`OWNER`**: required, protected, granted automatically. See [The owner role](/auth/roles/owner-role/).
- **`ADMIN`**: created by default but just a normal role; rename it, change its privileges, or delete it.

From there you can define as many roles as you need. See [Common role setups](/auth/roles/common-setups/) for a worked example.

## Where role and privileges live

Both travel in the verified JWT, decoded onto the request by `bridge.auth()` / `bridge.protect()`:

| Claim | Ends up on | Type |
|---|---|---|
| `role` | `req.bridgeUser.role` | `string \| undefined` |
| `privileges` | `req.bridgeUser.privileges` | `string[] \| undefined` |
| `privileges` (API token) | `req.bridgeApiToken.privileges` | `string[]` |

```typescript
import { Router } from 'express';

const router = Router();

router.get('/users/me', (req, res) => {
  const user = req.bridgeUser!;
  res.json({ role: user.role, privileges: user.privileges });
});
```

There is no server-side lookup involved; the middleware never queries a roles database. Whatever role/privileges are embedded in the token *are* the role/privileges for that request. See [How the token is kept current](/auth/user-token/object-updates/) for what that implies when a role changes mid-session.

Notably, the backend sees **more** than a typical frontend does here: a frontend's live snapshot exposes `role` but not the underlying `privileges` array (privileges travel in the JWT, not the frontend session snapshot). Express verifies the JWT itself, so `req.bridgeUser.privileges` is available directly. That's useful if you need finer-grained checks than "does this role match."

## Two separate enforcement mechanisms

This is the part that trips people up: **role checks and privilege checks are enforced against different credential types.**

| Option (on `bridge.protect(...)`) | Applies to | Bypassed by |
|---|---|---|
| `role` | User JWT only; checks `req.bridgeUser.role` | API tokens don't carry a `role`, so this option has no effect on API-token-only requests |
| `privilege` | API token only; checks `req.bridgeApiToken.privileges` | User JWTs bypass this check entirely (so an endpoint that adds `privilege` for API-token enforcement doesn't break existing user-JWT access) |
| Route-rule `privilege` (e.g. `{ path: '/users/*', privilege: 'USER_READ' }`) | User JWT only; checks `req.bridgeUser.privileges` | Only evaluated when a user JWT is present on the request, and only by `bridge.auth()`; `bridge.protect()` ignores route rules entirely |

In practice: use `bridge.protect({ role })` (or a route-rule `privilege`) to gate what a **signed-in person** can do, and `bridge.protect({ privilege })` to gate what a **token** (script, integration, CI job) can do. See [API tokens](/auth/api-tokens/) for the full API-token auth flow.

```typescript
import { Router } from 'express';

const admin = Router();
admin.use(bridge.protect({ role: 'ADMIN' })); // every route on this router requires ADMIN

admin.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard', admin: req.bridgeUser!.email });
});

app.use('/admin', admin);

// A separate OWNER-only route, gated at the route level
app.get('/billing/account', bridge.protect({ role: 'OWNER' }), (req, res) => {
  res.json({ settings: 'sensitive data' });
});
```

The role check is an **exact match** against the single role in the token, so don't stack two different `role` requirements on the same route (a router-level `ADMIN` plus a route-level `OWNER` can never both pass; a user has exactly one role per workspace). Give each route one `role` requirement.

A `403 Forbidden` with `"Role '<role>' required"` (or `"Privilege '<privilege>' required"`) is returned when the check fails. See [Configuration](/auth/config/) for the response shape.

For anything security-critical, enforce it here, in `bridge.auth()`/`bridge.protect(...)` on the actual endpoint; never rely on a role check that only exists in a caller's UI.
