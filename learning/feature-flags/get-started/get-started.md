# Get started

Feature flags in Bridge Express ride on the same `bridge` instance you already
create for auth — there's no separate flags module to install or initialize.
Once a route is authenticated, adding a flag requirement is one option on
`bridge.protect(...)`.

## Create the bridge instance

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

The flag evaluator is wired up internally when you call `createBridge(...)` —
no flag-specific setup call. Configuration comes from the same `appId` (and
optional `apiBaseUrl`) you already pass; flags evaluate over the derived
`{apiBaseUrl}/cloud-views` endpoint. See [Configuration](/auth/config/) for the
full `BridgeConfig` reference.

## Gate your first route

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

Flip `beta-access` on in Control Center and the route opens for the users your
rule targets — no redeploy. When the flag is off for a caller, the middleware
returns `403 Forbidden` before your handler runs:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

> **Tip:** Flag gating applies to the user-JWT path only — it is not evaluated
> for API-token callers. Use it to gate what a signed-in person can reach.

That's the whole loop. From here:

- **[Guard routes](/feature-flags/using/guard-routes/)** — gate a single route or a whole router, and combine flags with `any` / `all`.
- **[Use flags in your logic](/feature-flags/using/in-logic/)** — branch inside a handler instead of gating the whole route.
- **[Target by plan or role](/feature-flags/targeting/by-plan-or-role/)** — target the rule on the identity already in the token.
