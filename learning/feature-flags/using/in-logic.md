# Use flags in your logic

Gating a route with `bridge.protect({ featureFlag })` is the right tool when
the flag decides *whether the endpoint exists at all*. But sometimes the same
flag should decide *what the handler does* (which implementation runs, what
limit to enforce, which branch to take) while the route itself stays
reachable. For that, evaluate the flag inside the handler.

## Gate-then-branch (recommended)

The simplest pattern keeps the flag as a boolean gate but lets both sides of
the decision run: authenticate the route normally, then branch on a second
flag without gating on it.

Since a bare `bridge.protect({ featureFlag })` returns `403` when the flag is
off, use it only for the "must be on" case. To *branch* rather than reject,
keep the flag off the guard and evaluate it in the handler with the caller's
token, which the guard already put on the request as `req.bridgeAccessToken`:

```typescript
import { Router } from 'express';
import { createBridge, FeatureFlagService, BridgeConfigService } from '@nebulr-group/bridge-express';

// Reuse the same config your bridge instance was created with.
const flags = new FeatureFlagService(new BridgeConfigService({ appId: process.env.BRIDGE_APP_ID! }));

const router = Router();

router.get('/pricing', async (req, res) => {
  // The route is already authenticated by bridge.auth() / bridge.protect(),
  // so req.bridgeAccessToken holds the verified user JWT.
  const useV2 = await flags.isEnabled('pricing_engine_v2', req.bridgeAccessToken!);

  // Branch logic: neither path is a 403; the flag just picks the code path.
  const total = useV2 ? calculateTotalV2(req.query) : calculateTotalV1(req.query);
  res.json({ total, engine: useV2 ? 'v2' : 'v1' });
});
```

`FeatureFlagService` is exported from the package. It's the same evaluator the
middleware uses internally: construct it with a `BridgeConfigService` built
from the same `appId` (and `apiBaseUrl`, if you override it) as your `bridge`
instance, and its per-token cache means a check right after the guard usually
hits the warm cache rather than the network.

## The evaluation API

`FeatureFlagService` exposes:

| Method | Signature | Returns |
|--------|-----------|---------|
| `isEnabled` | `isEnabled(flag, accessToken, forceLive?)` | `Promise<boolean>` |
| `evaluateRequirement` | `evaluateRequirement(requirement, accessToken)` | `Promise<boolean>` |
| `bulkEvaluate` | `bulkEvaluate(accessToken)` | `Promise<Map<string, boolean>>` |
| `clearCache` | `clearCache()` | `void` |

- **`accessToken`** is the user's JWT; read it from `req.bridgeAccessToken` on
  an authenticated route.
- **`forceLive`** (default `false`) bypasses the per-token cache and re-hits
  the Bridge API. Use it only when you need an up-to-the-second value and can
  afford the network round-trip.
- **`evaluateRequirement`** takes the same `FeatureFlagRequirement`
  (`string | { any } | { all }`) as the middleware, so you can reuse an
  `any`/`all` combination in handler logic.
- Every method **fails closed**: a network error or unreachable Bridge
  resolves to `false` (or an empty map), never throwing into your handler.

## Enforce a limit an admin can tune

Because the value comes from Bridge, an admin can change *who* a flag is on
for without a redeploy, so a flag makes a good switch for a feature you want
to be able to turn on per workspace (called a *tenant* in the API) from
Control Center (your admin dashboard at app.thebridge.dev):

```typescript
router.post('/exports', async (req, res) => {
  const bulkExports = await flags.isEnabled('bulk_exports', req.bridgeAccessToken!);
  if (!bulkExports && req.body.rows > 100) {
    return res.status(422).json({ message: 'Bulk export not enabled for your plan' });
  }
  // ... run the export
});
```

Here the flag doesn't gate the route (a `403` would be the wrong answer): the
handler owns the fallback and returns a domain-appropriate response. This is
the pattern to reach for whenever "flag off" shouldn't simply mean
"404 / 403".

> **Tip:** If a flag *should* reject the request outright when off, prefer the
> declarative gate, `bridge.protect({ featureFlag })`, over an in-handler
> `if`. Reach for in-handler evaluation only when you need to branch, tune a
> limit, or control the off-case response yourself.
