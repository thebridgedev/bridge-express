---
title: Feature Flags
order: 40
oneLiner: Gate a route or branch server-side logic on a flag — flip it live from Control Center, no redeploy.
related: [auth, payments]
---

# Feature Flags

Bridge Feature Flags let you gate behavior on a switch you control from Control Center instead of from a deploy. In Bridge Express that switch is enforced **on the server, during the request**: `bridge.protect({ featureFlag })` evaluates the flag against the requesting user's access token and returns `403 Forbidden` before your handler runs when it isn't enabled.

Evaluation happens over the Bridge API and is **keyed on the user JWT**, so it applies to the user-JWT path only — not to API-token callers. The result is cached per token, so repeated checks from the same user within the cache window don't re-hit the network.

## Gating a route on a single flag

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

## Requirement objects — any / all

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

Flags here are **boolean** — the middleware gates on enabled/not-enabled. (For multi-type variants, roll them out on a Bridge frontend SDK where flags evaluate client-side.)

## Where to go next

- **[How flags work](/feature-flags/how-it-works/)** — the server-side evaluation model, per-token caching, and what stays up through outages.
- **[Get started](/feature-flags/get-started/)** — wire the `bridge` instance and gate your first route.
- **[Guard routes](/feature-flags/using/guard-routes/)** — gate a single route or a whole router.
- **[Use flags in your logic](/feature-flags/using/in-logic/)** — branch handler logic on a flag instead of gating the whole route.
- **[Server-side evaluation](/feature-flags/using/backend/)** — how the backend evaluates, and what to trust.
- **[Target by plan or role](/feature-flags/targeting/by-plan-or-role/)** — target on the identity Bridge already knows from the token.
- **[Send context from your code](/feature-flags/targeting/send-context/)** — what the backend can and can't supply to a rule.
