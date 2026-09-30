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

## How roles and privileges are enforced

What a role can do is only true **in the default setup**; every app can change it. Read the app's real roles and privileges (`list_roles` / `bridge role list`) before writing a rule.

Two mechanisms, for two kinds of caller:

| Mechanism | Applies to | What decides |
|---|---|---|
| `bridge.protect({ featureFlag })` (or a route rule's `featureFlag`) | A signed-in person (user JWT) | The flag's rule, e.g. `privileges contains "USER_WRITE"` |
| `bridge.protect({ privilege })` | API tokens only; checks `req.bridgeApiToken.privileges` | The token's scope. It is not a gate on a person, so a user JWT is not checked against it |

In practice: gate what a **signed-in person** can do with a flag ruled on a privilege, and scope what a **token** (script, integration, CI job) can do with `bridge.protect({ privilege })`. Prefer a privilege rule over a role rule; write `user.role eq "ADMIN"` only when you mean the role itself. `contains` is exact membership. App code never reads `req.bridgeUser.role` or `privileges` to decide access. See [Gate with feature flags](/auth/roles/gate-with-flags/) and [API tokens](/auth/api-tokens/).

```typescript
import { Router } from 'express';

const admin = Router();
admin.use(bridge.protect({ featureFlag: 'admin-area' })); // rule: privileges contains "USER_WRITE"

admin.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard', admin: req.bridgeUser!.email });
});

// A stricter route inside the same area
admin.get('/settings', bridge.protect({ featureFlag: 'admin-settings' }), (req, res) => {
  // rule: privileges contains "TENANT_WRITE"
  res.json({ settings: 'sensitive data' });
});

app.use('/admin', admin);
```

Stacked `protect(...)` calls each run; a request must pass every flag on its path. A refused request gets 403 `FEATURE_NOT_PERMITTED` (or `FEATURE_OFF`) naming the flag, or 402 `FEATURE_NOT_IN_PLAN` when only an upgrade would turn it on.

`bridge.protect({ role })` was removed: passing it (or a route rule with a privilege key, `role`, `plans` or `entitlement`) stops the app at startup with an error naming the flag to use instead. Run `npx @nebulr-group/bridge-cli check gates` to list every direct role, privilege or plan check left in the code.

For anything that must be enforced (not just hidden in a caller's UI), put the flag on the actual endpoint too; the same rule answers the same way in the browser and the backend.
