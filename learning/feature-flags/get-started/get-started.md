# Get started

Flags come with the SDK you already have: feature flags in Bridge Express ride
on the same `bridge` instance you create for auth, so there's no separate
flags module to install and no flag-specific init call. Once a route is
authenticated, adding a flag requirement is one option on
`bridge.protect(...)`.

## 1. Set up the SDK

`createBridge(...)` takes your `appId` (all a flags-capable backend needs) and
returns the instance whose middleware factories evaluate flags for you:

```typescript
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
  },
});

const app = express();
app.use(bridge.auth()); // authenticate every route registered below
```

The flag evaluator is wired up internally when you call `createBridge(...)`;
there is no flag-specific setup call. Configuration comes from the same
`appId` (and optional `apiBaseUrl`) you already pass; flags evaluate over the
derived `{apiBaseUrl}/cloud-views` endpoint. See
[Configuration](/auth/config/) for the full `BridgeConfig` reference.

## 2. Create a flag in Control Center

In Control Center (your admin dashboard at app.thebridge.dev), open Feature
Flags and create a boolean flag, for example `beta-access`, and leave it off.

## 3. Gate your first route

A flag is evaluated against the requesting user's access token, so the route
must be authenticated (the caller sends a user JWT). Add `featureFlag` to
`bridge.protect(...)`:

```typescript
import { Router } from 'express';
const router = Router();

router.get('/beta/feature', bridge.protect({ featureFlag: 'beta-access' }), (req, res) => {
  res.json({ feature: 'beta-data', user: req.bridgeUser });
});

export default router;
```

While the flag is off for a caller, the middleware returns `403 Forbidden`
before your handler runs:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

> **Tip:** Flag gating applies to the user-JWT path only; it is not evaluated
> for API-token callers. Use it to gate what a signed-in person can reach.

## 4. Flip it and watch the route open

Go back to Control Center and turn `beta-access` on. The route opens for the
users your rule targets, no redeploy: the change governs the next evaluation
(a caller inside the per-token cache window may briefly see the previous
answer). Flip it off again and the route closes the same way.

That's the whole loop: create a flag, gate a route with a safe default of
"closed", and control it from Control Center from then on.

## Next steps

- [Guard routes](/feature-flags/using/guard-routes/) to gate a single route or a whole router, and combine flags with `any` / `all`
- [Use flags in your logic](/feature-flags/using/in-logic/) to branch inside a handler instead of gating the whole route
- [Target by plan or role](/feature-flags/targeting/by-plan-or-role/) to target the rule on the identity already in the token
