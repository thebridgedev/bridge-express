# Feature Flags

Bridge Express gates routes on feature flags evaluated **on demand over the Bridge API**, keyed on the requesting user's access token. A flag check happens during the request, asynchronously, and the result is cached per token so repeated checks within the cache window don't re-hit the network.

Feature-flag gating in Express is a route-level concern: you attach it with `bridge.protect({ featureFlag })`. The flag is evaluated against the **user JWT** — it applies to the user-JWT path only, not to API-token callers.

### Gating a route on a single flag

```typescript
import { Router } from 'express';
const router = Router();

router.get('/beta/feature', bridge.protect({ featureFlag: 'beta-access' }), (req, res) => {
  res.json({ feature: 'beta-data', user: req.bridgeUser });
});

export default router;
```

If the flag is disabled for the requesting user, the middleware returns `403 Forbidden` before the handler runs:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

### Requirement objects — any / all

The `featureFlag` option accepts a single flag key, or a requirement object combining multiple flags:

```typescript
// Single flag
bridge.protect({ featureFlag: 'beta-access' })

// All flags must be enabled
bridge.protect({ featureFlag: { all: ['premium', 'active-subscription'] } })

// Any flag must be enabled
bridge.protect({ featureFlag: { any: ['plan-pro', 'plan-enterprise'] } })
```

The `FeatureFlagRequirement` type:

```typescript
type FeatureFlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };
```

These work with boolean flags.

### Gating a whole router

Because `bridge.protect(...)` is just Express middleware, you can apply a flag requirement to a group of routes:

```typescript
import { Router } from 'express';
const beta = Router();

// Every route on this router requires the 'beta-access' flag
beta.use(bridge.protect({ featureFlag: 'beta-access' }));

beta.get('/dashboard', handler);
beta.get('/reports', handler);

app.use('/beta', beta);
```

### Programmatic checks inside a handler

When you need a flag value to branch logic rather than gate the whole route, evaluate it inside the handler. The route still needs auth (so `req.bridgeAccessToken` is populated); branch on the flag from there.

A common pattern is to combine an authenticated route with an entitlement or subscription check via the unified tenant surface (see [Tenant Data](../bridge-service/bridge-service.md)):

```typescript
router.get('/exports', (req, res) => {
  // The route is already authenticated by the guard / protect middleware.
  // Branch on a flag or an entitlement before doing work.
  // ...
});
```

> **How evaluation works.** Flags are evaluated over the Bridge API (`{apiBaseUrl}/cloud-views`) using the user's access token. The result is cached per token, so a route guarded by `bridge.protect({ featureFlag })` does not re-hit the network on every request from the same user within the cache window.

### When the flag is unreachable

Feature-flag evaluation is gated only on a positive result. If the Bridge API is unreachable, the requirement is treated as not satisfied (the route returns 403). For kill-switch-style routes where you want the flag absent to mean "allow", gate the route with a normal privilege rule and check the flag programmatically inside the handler instead, so you control the fallback.
