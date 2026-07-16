# Guard routes

Gating a route on a flag in Express is the `featureFlag` option on
`bridge.protect(...)`. Because `bridge.protect(...)` is just Express
middleware, the same option works on a single route or on a whole router.

## Gate a single route

```typescript
import { Router } from 'express';
const router = Router();

router.get('/beta/feature', bridge.protect({ featureFlag: 'beta-access' }), (req, res) => {
  res.json({ feature: 'beta-data', user: req.bridgeUser });
});
```

A request that doesn't satisfy the flag gets `403 Forbidden` before your
handler runs. This is real server-side enforcement, not a hidden button:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

## Gate a whole router

Mount the requirement on a router to protect a group of routes in one line:

```typescript
import { Router } from 'express';
const beta = Router();

// Every route on this router requires the 'beta-access' flag
beta.use(bridge.protect({ featureFlag: 'beta-access' }));

beta.get('/dashboard', handler);
beta.get('/reports', handler);

app.use('/beta', beta);
```

Middleware order works the normal Express way: a route-level
`bridge.protect({ featureFlag })` runs in addition to a router-level one, so a
route can require both.

## Combine multiple flags: any / all

The `featureFlag` option accepts a single key or a requirement object:

```typescript
// Single flag
bridge.protect({ featureFlag: 'beta-access' })

// All flags must be enabled
bridge.protect({ featureFlag: { all: ['premium', 'active-subscription'] } })

// Any flag must be enabled
bridge.protect({ featureFlag: { any: ['plan-pro', 'plan-enterprise'] } })
```

```typescript
type FeatureFlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };
```

`any` passes if at least one flag is enabled; `all` passes only if every flag
is. Each key is evaluated against the same access token.

## Combine with role and privilege on one route

`featureFlag` composes with the other `bridge.protect(...)` options; they're
all checked in the same middleware. A route can require a role *and* a flag:

```typescript
router.get(
  '/reports/beta',
  bridge.protect({ role: 'ADMIN', featureFlag: 'beta_reports' }),
  (req, res) => {
    res.json({ report: buildBetaReport(req.bridgeUser!.tenantId) });
  },
);
```

The role check runs against the user JWT's `role`, the flag against the same
token. See [Route guards](/auth/securing/route-guards/) for the full order of
checks, and [Gate features by role or privilege](/auth/roles/gate-with-flags/)
for role/privilege targeting of the flag rule itself.

> **Feature flags aren't route rules.** Unlike privilege, which you can list
> centrally in `guard.rules`, a `featureFlag` requirement lives only on
> `bridge.protect(...)`. Declare it on the route or router, not in the guard
> config.

## When the flag is unreachable

Flag evaluation is satisfied only on a positive result. If the Bridge API is
unreachable, the requirement is treated as not satisfied and the route returns
`403`. For a kill-switch-style route where the flag being absent should mean
"allow", gate the route with a normal privilege/role rule and check the flag
programmatically inside the handler instead, so you control the fallback; see
[Use flags in your logic](/feature-flags/using/in-logic/).
