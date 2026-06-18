# Bridge Express — Feature Flags

You are adding **Feature Flags** to an Express application that uses The Bridge. The goal is to ship code behind a switch you control from the Bridge dashboard — no redeploy needed.

Express evaluates flags **on demand over the Bridge API**, against the caller's verified user access token, with a short (5-minute) per-token in-memory cache. There are two forms — both use the same evaluation path:

- **Declarative — `bridge.protect({ featureFlag })`** gates a whole route. The middleware evaluates the requirement against the request's user JWT and returns 403 when it isn't satisfied. Use for simple route gating.
- **Programmatic — `FeatureFlagService`** checks a flag inside a handler so you can branch logic (not just gate access). Use when you want to read a flag's enabled/disabled state and act on it.

> **Express has no live-updating flags client.** Unlike some Bridge backend plugins, express does not run a local rule engine with a WebSocket subscription. Flags evaluate on demand with a short cache, so a dashboard change is picked up on the next request once the cache TTL elapses (or immediately with `forceLive`). Flag checks apply to **user-JWT callers** — they need a verified access token to evaluate against.

## Prerequisites

1. `@nebulr-group/bridge-express` installed and `createBridge(config)` called at startup (see `integration-prompt.md`).
2. Routes are authenticated — flag evaluation runs against the user's verified access token, so the caller must present a valid user JWT.

## Declarative — gate a route with `bridge.protect({ featureFlag })`

`featureFlag` accepts a single flag string, `{ any: string[] }` (at least one enabled), or `{ all: string[] }` (all enabled). `protect()` always enforces auth, then evaluates the flag for the authenticated user; a disabled flag returns 403.

```ts
import { Request, Response } from 'express';

// Single flag
app.get('/reports/beta', bridge.protect({ featureFlag: 'beta-access' }), (req: Request, res: Response) => {
  res.json({ report: 'beta' });
});

// All of several flags must be enabled
app.get('/reports/premium', bridge.protect({ featureFlag: { all: ['premium-tier', 'active-subscription'] } }), (req, res) => {
  res.json({ report: 'premium' });
});

// Any one of several flags is enough
app.get('/reports/experimental', bridge.protect({ featureFlag: { any: ['beta-tester', 'internal-user'] } }), (req, res) => {
  res.json({ report: 'experimental' });
});
```

Boolean flags only on this path. The check is enforced by the same guard that handles auth — see `auth-prompt.md` for how `protect()` composes with `role`, `privilege`, and `acceptAuth`.

## Programmatic — `FeatureFlagService`

When you want to **read** a flag and branch (rather than gate the whole route), construct a `FeatureFlagService` and call it inside your handler. It evaluates against the user's access token (`req.bridgeAccessToken` after the guard runs).

```ts
import { Request, Response } from 'express';
import { FeatureFlagService, BridgeConfigService } from '@nebulr-group/bridge-express';

const flags = new FeatureFlagService(
  new BridgeConfigService({ appId: process.env.BRIDGE_APP_ID! }),
);

app.get('/export', bridge.protect(), async (req: Request, res: Response) => {
  if (await flags.isEnabled('pdf-export', req.bridgeAccessToken!)) {
    return res.json(exportPdf());
  }
  return res.json(exportPlain());
});
```

`FeatureFlagService.isEnabled(flag, accessToken, forceLive?)`:
- Returns `Promise<boolean>`. Boolean flags only.
- `forceLive: true` bypasses the 5-minute per-token cache and makes a live API call.
- Fails safe: if Bridge is unreachable or the flag isn't configured, it resolves to `false` — a flag check never throws or breaks the request.

`FeatureFlagService.evaluateRequirement(requirement, accessToken)` evaluates a single string, `{ any }`, or `{ all }` requirement — the same shape `protect({ featureFlag })` accepts:

```ts
const ok = await flags.evaluateRequirement({ all: ['premium-tier', 'active-subscription'] }, req.bridgeAccessToken!);
```

Reuse a single `FeatureFlagService` instance so its cache is shared across requests; don't construct one per request.

## Identity

Flags are evaluated **on behalf of the authenticated user** — the user's access token is the identity. The Bridge API derives the eval context (user, tenant) from that token, so percentage rollouts and per-user/per-tenant rules bucket consistently with the frontend, which evaluates against the same user. You do not pass an identity explicitly; presenting the user's JWT is what scopes the evaluation.

Because the gate runs on a verified token, **role/plan targeting rules read from server-verified claims** — there is no client-supplied attribute to spoof on this path.

## Checklist

- [ ] Route gates use `bridge.protect({ featureFlag })` with a single string, `{ any }`, or `{ all }`
- [ ] Programmatic checks construct one shared `FeatureFlagService` and call `isEnabled` / `evaluateRequirement` with `req.bridgeAccessToken`
- [ ] Flag checks run only on authenticated (user-JWT) routes — the access token is the identity
- [ ] Code tolerates `false` as the safe default (unconfigured flag or Bridge unreachable)
- [ ] `forceLive: true` used only where you specifically need to skip the 5-minute cache

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Flag off (default):** a `bridge.protect({ featureFlag: 'beta-access' })` route returns 403 while the flag is off (it's auto-created as off in the dashboard on first eval).
3. **Toggle on:** enable the flag in **Feature Control** in the Bridge dashboard — the route returns 200 without a redeploy, on the next request after the cache TTL (or immediately with `forceLive`).
4. **Programmatic branch:** a handler reading `flags.isEnabled(...)` returns the alternate branch's output once the flag flips.
