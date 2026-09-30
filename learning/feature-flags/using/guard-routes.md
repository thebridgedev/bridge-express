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

A request that doesn't satisfy the flag is refused before your handler runs.
This is real server-side enforcement, not a hidden button. The refusal says
why the flag is off, as Bridge's flag evaluation reported it:

| Why the flag is off | Status | `code` | `fix` |
|---|---|---|---|
| The workspace's plan doesn't include it: an upgrade alone would turn it on | `402` | `FEATURE_NOT_IN_PLAN` | where to upgrade (`billing.manageRoute`, default `/subscription`) |
| The person's role or privileges keep it off | `403` | `FEATURE_NOT_PERMITTED` | ask a workspace admin |
| Switched off, another condition, or outside the rollout | `403` | `FEATURE_OFF` | none |

```json
{
  "statusCode": 403,
  "code": "FEATURE_OFF",
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled",
  "flag": "beta-access",
  "reason": "off",
  "fix": "This feature is switched off for everyone."
}
```

A plan refusal names the plan feature the flag's rule asks for, when it
targets one (`bridge:billing.entitlement.<feature>`):

```json
{ "statusCode": 402, "code": "FEATURE_NOT_IN_PLAN", "flag": "exports_enabled",
  "feature": "exports", "reason": "plan", "fix": "/subscription",
  "message": "Your plan does not include 'exports'. Upgrade to use it." }
```

The 403s keep the old `statusCode` / `error` / `message` fields. Set where a
402 points with `createBridge({ ..., billing: { manageRoute: '/billing' } })`.

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

## Role, privilege and plan go in the flag's rule

Who may use a route is one flag; the flag's rule says why. For "admins, and
only while the beta runs", rule `beta_reports` on
`privileges contains "USER_WRITE"` plus the rollout, rather than adding a
second check in code:

```typescript
router.get(
  '/reports/beta',
  bridge.protect({ featureFlag: 'beta_reports' }),
  (req, res) => {
    res.json({ report: buildBetaReport(req.bridgeUser!.tenantId) });
  },
);
```

`bridge.protect({ role })` was removed (it throws at startup, naming the flag
to use). See [Route guards](/auth/securing/route-guards/) for the full order of
checks, and [Gate features by role or privilege](/auth/roles/gate-with-flags/)
for role/privilege targeting of the flag rule itself.

A flag can also go centrally on a route rule under `bridge.auth()`:
`{ path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' }`.

Who may use a feature is the flag; how many is the quota. A route can carry
both: `bridge.protect({ featureFlag: 'exports-enabled' })` then
`bridge.requireQuota('exports')`. See [Plan limits](../../plan-limits/plan-limits.md).

## When the flag is unreachable

Flag evaluation is satisfied only on a positive result. If the Bridge API is
unreachable, the requirement is treated as not satisfied and the route returns
`403`. For a kill-switch-style route where the flag being absent should mean
"allow", protect the route without the flag (`bridge.protect()`) and check the flag
programmatically inside the handler instead, so you control the fallback; see
[Use flags in your logic](/feature-flags/using/in-logic/).
