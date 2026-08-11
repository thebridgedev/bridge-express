# Bridge Express — Feature Flags

You are adding **Feature Flags** to an Express API that uses The Bridge. The goal is to ship an endpoint behind a switch you control from the Bridge dashboard — no redeploy needed.

This is a **backend** SDK. There is no demo page and no component to render; the equivalents are a **gated route** and a **curl that proves the gate**. Flags evaluate **server-side, during the request, against the caller's verified user JWT** — which makes this the enforcement boundary, not a UX affordance a client can lie about.

## Prerequisites check

Before starting, verify that Bridge is set up in this project:

1. `@nebulr-group/bridge-express` is in `package.json` dependencies
2. `createBridge({ appId })` is called **once** at startup (usually `src/app.ts` or `src/index.ts`) and the returned instance is reused everywhere
3. `app.use(bridge.auth())` is mounted, or the routes you intend to gate already use `bridge.protect(...)`
4. `BRIDGE_APP_ID` is set in `.env`

If any are missing, run `bridge guide express` first. Flags here are not a separate feature — they ride the auth path, and the token *is* the identity.

## Step 1 — Activate the flags layer

There is nothing to activate. `createBridge(config)` constructs the `FeatureFlagService` internally and hands it to both middleware factories, so any instance that can authenticate can already evaluate flags:

```ts
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();

export const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
  },
});

app.use(bridge.auth());
```

No subpath import, no `forRoot()`, no flags-specific package. Evaluation is derived from the same `appId` (and optional `apiBaseUrl`, default `https://api.thebridge.dev`) and POSTs to `{apiBaseUrl}/cloud-views`.

> Ignore any snippet — including the express output of `bridge flag init` — that tells you to import `@nebulr-group/bridge-express/flags`, or to call `createBridgeFlags()`, `bridge.middleware()` or `req.bridge.flag()`. **None of those exist in this package.** The package root is the only entry point.

## Step 2 — Gate your first route

Server-side evaluation **does not auto-create a flag**. An unknown key evaluates to not-enabled forever, so create it first — off:

```bash
bridge flag create --key beta-access --value-type boolean --state off
```

Then gate one route with it, and put an ungated route beside it as a control:

```ts
// Control: auth only — proves your token is good.
app.get('/beta/ping', bridge.protect(), (req, res) => {
  res.json({ ok: true, user: req.bridgeUser?.email });
});

// Gated: the handler never runs while the flag is off.
app.get('/beta/feature', bridge.protect({ featureFlag: 'beta-access' }), (req, res) => {
  res.json({ feature: 'beta-data' });
});
```

Prove it with curl. `$TOKEN` is a **user** access token — sign in through your Bridge frontend and copy the value it puts in its `Authorization` header (the CLI does not mint user tokens):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" localhost:3000/beta/ping
# 200

curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/beta/feature
# {"statusCode":403,"error":"Forbidden","message":"Feature flag 'beta-access' is not enabled"}
```

That exact 403 body is what the guard writes when a flag is off — if you see it, the wiring is correct.

**After wiring this up, tell the user:**

> I've gated `GET /beta/feature` behind the **beta-access** flag — it returns 403 right now, while `/beta/ping` returns 200 with the same token. Go to **Feature Control** in the Bridge dashboard and turn **beta-access** on; the same request returns 200 within the 5-minute per-token cache window, with no redeploy.

## The two surfaces

**Declarative — `bridge.protect(options)`** gates the whole route; the handler never runs on failure. Real options:

| Option | Type | Applies to | Failure |
|---|---|---|---|
| `featureFlag` | `string \| { any: string[] } \| { all: string[] }` | user JWT only | `403` |
| `role` | `string` | user JWT only | `403` |
| `privilege` | `string` | API-token callers only | `403` |
| `acceptAuth` | `'jwt' \| 'api_token' \| 'both'` (default `'both'`) | credential type | `401` |
| `plans` | `string[]` | user JWT only | `402` `plan_required` |
| `entitlement` / `entitlements` | `string` / `string[]` | user JWT only | `402` `entitlement_missing` |

`protect()` always enforces auth and ignores config route rules — its options *are* the rule. Under `bridge.auth()`, a matched `RouteRule` may carry `featureFlag` instead, gating centrally from config.

**Programmatic — `FeatureFlagService`** reads a flag inside a handler so you can *branch* rather than reject:

| Method | Signature | Returns |
|---|---|---|
| `isEnabled` | `isEnabled(flag, accessToken, forceLive?)` | `Promise<boolean>` |
| `evaluateRequirement` | `evaluateRequirement(requirement, accessToken)` | `Promise<boolean>` |
| `bulkEvaluate` | `bulkEvaluate(accessToken)` | `Promise<Map<string, boolean>>` |
| `clearCache` | `clearCache()` | `void` |

```ts
import { FeatureFlagService, BridgeConfigService } from '@nebulr-group/bridge-express';

// One shared instance — the cache lives on it. Never construct per request.
const flags = new FeatureFlagService(new BridgeConfigService({ appId: process.env.BRIDGE_APP_ID! }));

app.get('/pricing', bridge.protect(), async (req, res) => {
  const v2 = await flags.isEnabled('pricing_engine_v2', req.bridgeAccessToken!);
  res.json({ total: v2 ? totalV2(req.query) : totalV1(req.query) });
});
```

`req.bridgeAccessToken` is the verified token the guard put on the request. Use `protect({ featureFlag })` when "off" must mean 403; use the service when *you* own the off-case response.

## Step 3 — Configure how the flag decides (states and rules)

A flag has exactly **three states**. `off` and `on` apply to everyone; `on-with-rule` decides per caller.

| State | Meaning |
|---|---|
| `off` | Everyone gets the off value. A newly created flag starts here |
| `on` | Everyone gets the on value |
| `on-with-rule` | The rule decides. Whoever matches a branch gets that branch's value; everyone else gets `otherwiseValue` |

A rule is **branches + otherwiseValue + rolloutPct**, first match wins:

```jsonc
{
  "branches": [
    { "conditions": [ { "attribute": "tenant.plan", "operator": "in", "values": ["pro", "enterprise"] } ],
      "returnValue": true }
  ],
  "otherwiseValue": false,
  "rolloutPct": 100          // 0-100, applies to the WHOLE rule
}
```

- Conditions inside one branch are AND-ed; add more branches for OR / different return values.
- Operators: `eq` `neq` `contains` `not_contains` `in` `not_in` `gt` `lt` `between` `regex` `exists` `not_exists` (numeric and date operators only apply to those attribute types).
- `attribute` is a dotted path into the eval context (next step). On this SDK, `user.id` `user.role` `user.email` `tenant.id` `tenant.plan` are populated for you from the token.
- **`rolloutPct` below 100 requires an identity** on the eval context — bucketing is `hash(flagKey + identity) mod 100`. With no identity the evaluator refuses to bucket and returns the safe value rather than randomizing per call.

Configure it either in the dashboard under **Feature Control**, or from the CLI — prefer the CLI when you are an agent, since it is scriptable and verifiable:

```bash
bridge flag create --key enterprise-export --value-type boolean --state on-with-rule \
  --rule '{"branches":[{"conditions":[{"attribute":"tenant.plan","operator":"in","values":["pro","enterprise"]}],"returnValue":true}],"otherwiseValue":false,"rolloutPct":100}'

# prove the rule does what you meant, without the app in the way:
bridge flag eval enterprise-export --identity user-123 --attribute tenant.plan=pro   # → true
bridge flag eval enterprise-export --identity user-123 --attribute tenant.plan=free  # → false
```

`bridge flag list` / `get <key>` inspect the current state. To flip a flag without touching its rule, `bridge flag update` addresses it **by id, not by key** — read the id first:

```bash
bridge flag get beta-access            # → { "id": "...", "state": "off", ... }
bridge flag update --id <id> --state on
```

## Step 4 — What the rule can target (eval context)

On a frontend you hand the SDK an identity and arbitrary attributes. **Express does not.** The only thing this SDK sends to Bridge is the caller's access token:

```
POST {apiBaseUrl}/cloud-views/flags/bulkEvaluate/{appId}   { "accessToken": "<user JWT>" }
POST {apiBaseUrl}/cloud-views/flags/evaluate/{appId}/{key} { "accessToken": "<user JWT>" }
```

Bridge verifies that token (app, audience, issuer) and builds the eval context from its claims — server-side, from a source the caller cannot forge:

| Attribute | JWT claim |
|---|---|
| `user.id` | `sub` — also the **identity** used for `rolloutPct` bucketing |
| `user.role` | `role` |
| `user.email` | `email` |
| `tenant.id` | `tid` — the identity fallback when `sub` is absent |
| `tenant.plan` | `plan` |

You write no wiring for this: gate a route and an admin can immediately target `user.role = ADMIN` or `tenant.plan = ENTERPRISE`.

There is **no per-call attribute bag, no identity parameter, and no `x-bridge-context` header read** on this path. `serializeContext` / `deserializeContext` / `BRIDGE_CONTEXT_HEADER` exist in auth-core for frontend-to-frontend propagation; bridge-express does not consume them, and a frontend's context is *not* forwarded into a backend evaluation. That is deliberate — a client that could inject `tenant.plan` could target itself into any flag.

When a decision depends on a fact only your backend knows ("more than 3 active projects"), the rule cannot reach it. Use the flag as a plain gate and apply the extra condition in your handler, against your own verified data.

## Server-side evaluation — the behaviour that matters

- **Per request, over the network.** The guard (or your `isEnabled` call) POSTs the token to the endpoints above. There is no local rule engine and no rule ever reaches your process.
- **Cached per token for 5 minutes.** The cache key is the first 16 chars of the access token. The first miss triggers a **bulk** evaluation that warms every flag for that user; later reads are in-memory. `isEnabled(flag, token, true)` bypasses the cache entirely. `clearCache()` drops everything.
- **Fails closed.** A non-2xx response, a network error, or an unknown flag key resolves to `false` — a gated route stays 403. An outage never opens a gate, and a flag check never throws into your handler.
- **Boolean only.** This path returns `enabled`. String / number / JSON flag values are *not* readable from Express — for a non-boolean flag, `enabled` merely reports whether a branch matched.
- **User-JWT callers only.** The flag check is skipped for API-token (`x-api-key`) callers; they are governed by `privilege` instead. Don't gate an M2M endpoint with `featureFlag`.
- **No realtime, no auto-creation.** There is no WebSocket subscription and no flag registry side effect. A dashboard change lands on the next evaluation after the cache TTL, and a key you never created stays off.

For anything this prompt doesn't cover — router-wide gating, `any`/`all` combinations, plan/entitlement gating, in-handler patterns — read `learning/feature-flags/` (`using/guard-routes.md`, `using/in-logic.md`, `using/backend.md`, `targeting/`) rather than guessing an API.

## Troubleshooting

- **Always 403 on a gated route.** The commonest cause is that the flag does not exist — Express never creates one. Run `bridge flag get <key>`; if it 404s, `bridge flag create --key <key> --state off` first.
- **401 instead of 403.** The gate runs auth before the flag. Check the control route (`bridge.protect()` with no options) with the same token; a missing/expired/foreign-app token fails there.
- **Gated route open for an API-token caller.** Expected — flag checks apply to user JWTs only. Use `acceptAuth: 'jwt'` if that endpoint must refuse API tokens.
- **Rule never matches?** Run `bridge flag eval <key> --identity … --attribute k=v` to see the verdict without the app in the way, then confirm the attribute exists in the *token* (`user.role`, `tenant.plan`, …) — Express cannot supply anything the token doesn't carry.
- **`rolloutPct < 100` with no identity** returns the safe value by design. On this path identity is `sub`, so an anonymous or tenant-less token buckets differently or not at all.
- **Dashboard flip not visible.** Wait out the 5-minute per-token cache, restart the process, call `flags.clearCache()`, or pass `forceLive: true`.
- **Non-boolean flag reads as `true`.** `enabled` is a boolean projection of "a branch matched". Don't model variants on the Express path.
- **Set `debug: true`** in `createBridge` — the guard logs `Feature flag check failed/passed` and the evaluation URL it called.

## Verify

1. **Build** — the project compiles with no TypeScript or import errors.
2. **`bridge flag get beta-access`** returns the flag with `"state": "off"`.
3. **Control route** — `GET /beta/ping` with a user token returns `200`. (If not, the problem is auth, not flags.)
4. **Gated route** — `GET /beta/feature` with the same token returns `403` and `Feature flag 'beta-access' is not enabled`.
5. **Flip it on** — toggle **beta-access** in **Feature Control**, or `bridge flag update --id <id> --state on`.
6. **Observe the change** — re-issue the same curl. Within the 5-minute cache window it returns `200` and the handler's body, with no redeploy. Force it immediately by restarting the process or evaluating with `forceLive: true`.
7. **Flip it off** — the route returns `403` again. The switch works in both directions.
