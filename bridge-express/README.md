<p align="center">
  <a href="https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thebridgedev/bridge-express/main/.github/assets/banner.png"><img src="https://raw.githubusercontent.com/thebridgedev/bridge-express/main/.github/assets/banner-light.png" alt="The Bridge for Express" width="100%"></picture></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nebulr-group/bridge-express"><img src="https://img.shields.io/npm/v/@nebulr-group/bridge-express?color=20006b&label=npm" alt="npm version"></a>
  <a href="https://github.com/thebridgedev/bridge-express/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@nebulr-group/bridge-express?color=20006b" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express"><b>Website</b></a> ·
  <a href="https://thebridge.dev/docs/quickstart/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express"><b>Quickstart</b></a> ·
  <a href="https://thebridge.dev/docs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express"><b>Docs</b></a> ·
  <a href="https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express"><b>Set up with your AI assistant</b></a>
</p>

# The Bridge for Express

`@nebulr-group/bridge-express` protects an Express API with Bridge: token verification, flag-gated routes, plan limits and tenant data, as middleware.

**[The Bridge](https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)** is a hosted backend for SaaS apps. It gives you sign-in (passwords, magic links, passkeys, social login and SSO), multi-tenant workspaces with roles, Stripe subscriptions with plan limits, and feature flags, all managed from one dashboard. Your AI coding assistant can set it up for you through the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express).

> **Let your AI assistant set it up.** Connect the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express) to Claude, Cursor, Copilot or Gemini CLI and ask it to add Bridge to your app. Not using MCP? Run `npx @nebulr-group/bridge-cli guide add-login` in your project: it detects your framework from `package.json` and prints the steps for your assistant to follow. `npx @nebulr-group/bridge-cli doctor` checks the result.

Provides JWT verification (JWKS), API-token verification, flag-gated routes, plan limits (`402 QUOTA_EXCEEDED`), tenant data and HTTP token-forwarding — without any NestJS dependency.

## Installation

```bash
npm install @nebulr-group/bridge-express
```

**Peer dependencies:**
```bash
npm install express @types/express @nebulr-group/bridge-auth-core
```

## Quick Start

```typescript
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

// appId / apiBaseUrl / debug come from BRIDGE_APP_ID / BRIDGE_API_BASE_URL /
// BRIDGE_DEBUG when you leave them out.
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/admin/*', privilege: 'AUTHENTICATED', featureFlag: 'admin-panel' },
    ],
  },
});

app.use(bridge.auth());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/items', (req, res) => res.json({ user: req.bridgeUser }));

// A plan limit: 402 QUOTA_EXCEEDED at the limit, the gauge set after a 2xx.
app.post(
  '/tickets',
  bridge.requireQuota('tickets', { current: (t) => tickets.countFor(t.id) }),
  (req, res) => res.status(201).json(tickets.create(req.bridgeTenant!.id)),
);

app.listen(3000);
```

## Configuration

`createBridge(config?)` accepts a `BridgeConfig` object. Explicit options win over the environment, which wins over the default.

| Option | Type | Default | Description |
|---|---|---|---|
| `appId` | `string` | `BRIDGE_APP_ID` (required one way or the other) | Your Bridge application ID |
| `apiBaseUrl` | `string` | `BRIDGE_API_BASE_URL`, else `https://api.thebridge.dev` | Bridge API base URL; every endpoint is derived from it |
| `debug` | `boolean` | `BRIDGE_DEBUG === 'true'` | Enable debug logging |
| `guard.defaultAccess` | `'public' \| 'protected'` | `'protected'` | Default access when no rule matches |
| `guard.rules` | `RouteRule[]` | `[]` | Route-level access rules |
| `billing.manageRoute` | `string` | `'/subscription'` | Sent as `fix` in `402` / `403` refusals so the frontend can link to your subscription page |
| `userJwksUrl` / `introspectionUrl` | `string` | derived from `apiBaseUrl` | Overrides for Docker setups |
| `introspectionCacheTtlMs` | `number` | `0` | Cache successful API-token introspections |

### Route Rules

```typescript
interface RouteRule {
  path?: string;                        // Supports * wildcard
  graphqlOperation?: string;            // GraphQL operation name
  privilege: 'ANONYMOUS' | 'AUTHENTICATED';
  featureFlag?: FeatureFlagRequirement; // The flag that decides who gets the route
}
```

**Every gate is a flag.** A rule says whether the route needs a signed-in caller; who gets it is the flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.<key> eq true`) or a rollout. A rule that gates on a role, a privilege string, `plans` or `entitlement(s)` fails at startup naming the flag to use instead.

## Middleware

### `bridge.auth()` — Global Auth Middleware

Use at the app or router level. Reads config rules and `defaultAccess`:

```typescript
app.use(bridge.auth());
```

### `bridge.protect(options?)` — Per-Route Protection

Always enforces auth. Optional flag, API-token privilege and accepted credential type:

```typescript
// Any authenticated user
router.get('/profile', bridge.protect(), handler);

// A flag decides who gets it (user JWTs)
router.get('/beta', bridge.protect({ featureFlag: 'beta-access' }), handler);
router.get('/premium', bridge.protect({ featureFlag: { all: ['premium-tier', 'active'] } }), handler);
router.get('/special', bridge.protect({ featureFlag: { any: ['flag-a', 'flag-b'] } }), handler);

// An API token's scope (API tokens only — not a gate on a person)
router.post('/sync', bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }), handler);
```

A flag that is off refuses with `402 FEATURE_NOT_IN_PLAN` when an upgrade alone would turn it on, otherwise `403 FEATURE_NOT_PERMITTED` / `FEATURE_OFF`.

`role`, `plans`, `entitlement` and `entitlements` were removed from `protect()` in 0.7.0; passing one throws when the middleware is created. See the CHANGELOG for the migration.

### `bridge.public()` — Skip Auth

Marks a route as public, bypassing `bridge.auth()`:

```typescript
router.get('/health', bridge.public(), handler);
```

### Plan limits — `bridge.requireQuota` / `bridge.syncQuota`

Put them after `bridge.auth()` / `bridge.protect()`.

```typescript
// Gauge (things that exist): your count is compared; after a 2xx the gauge is set to it.
router.post('/tickets', bridge.requireQuota('tickets', { current: (t) => tickets.countFor(t.id) }), create);
router.delete('/tickets/:id', bridge.syncQuota('tickets', { current: (t) => tickets.countFor(t.id) }), remove);

// Counter (things that happened): Bridge's tally is compared; one event after a 2xx,
// deduplicated by the request's Idempotency-Key header.
router.post('/exports', bridge.protect({ featureFlag: 'exports-enabled' }), bridge.requireQuota('exports'), exportIt);
```

At the limit the request is refused before the handler runs:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "Your plan allows 5 tickets; 5 are in use.",
  "metric": "tickets", "used": 5, "limit": 5, "fix": "/subscription" }
```

Usage is recorded only after a 2xx (a thrown or 4xx/5xx handler records nothing), before the response is released. A `metered` quota never refuses. If the quota cannot be read the request is refused with `503` (fail-closed). `bridge.quota` has the same logic as plain calls (`check`, `assertQuota`, `record`, `sync`, `assertEntitlement`). See [Plan limits](https://thebridge.dev/docs/plan-limits/).

`bridge.requireEntitlement(key)` refuses with `403 ENTITLEMENT_REQUIRED` unless the plan includes `key` — the exception for when you explicitly want no flag.

## Request Fields

After successful auth, these fields are available on the request:

```typescript
req.bridgeUser        // BridgeUser — authenticated user info
req.bridgeTenant      // BridgeTenant | undefined — tenant info
req.bridgeAccessToken // string — raw JWT token
req.bridgeApiToken    // ApiTokenClaims — API-token callers
```

`bridge.fromRequest(req)` returns the verified user's tenant view: `subscription`, `entitlements`, `usage`, `branding`, `user`.

## RFC 6750 WWW-Authenticate Headers

401 responses include RFC 6750-compliant `WWW-Authenticate` headers:

| Scenario | Header value |
|---|---|
| No token | `Bearer error="missing_token", error_description="..."` |
| Expired token | `Bearer error="expired_token", error_description="..."` |
| Invalid token | `Bearer error="invalid_token", error_description="..."` |

## Token Forwarding with `bridge.http`

`bridge.http` is a `BridgeHttpService` instance for making HTTP calls to downstream services with the user's token forwarded:

```typescript
app.get('/forward/items', async (req, res) => {
  const data = await bridge.http.get('http://service-b/items', req.bridgeAccessToken);
  res.json(data);
});
```

Available methods: `get`, `post`, `put`, `patch`, `delete`. Throws `BridgeHttpError` (with `.status` and `.url`) on non-2xx responses.

## Learn more

- [Quickstart](https://thebridge.dev/docs/quickstart/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Authentication](https://thebridge.dev/docs/auth/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Feature flags](https://thebridge.dev/docs/feature-flags/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Plan limits](https://thebridge.dev/docs/plan-limits/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Tenant data](https://thebridge.dev/docs/bridge-service/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Multi-tenancy](https://thebridge.dev/docs/multi-tenancy/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Error handling](https://thebridge.dev/docs/error-handling/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)
- [Examples](https://thebridge.dev/docs/examples/express/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express)

## Other Bridge packages

| Package | For |
|---|---|
| [`@nebulr-group/bridge-svelte`](https://www.npmjs.com/package/@nebulr-group/bridge-svelte) | SvelteKit |
| [`@nebulr-group/bridge-react`](https://www.npmjs.com/package/@nebulr-group/bridge-react) | React |
| [`@nebulr-group/bridge-nextjs`](https://www.npmjs.com/package/@nebulr-group/bridge-nextjs) | Next.js |
| [`@nebulr-group/bridge-angular`](https://www.npmjs.com/package/@nebulr-group/bridge-angular) | Angular |
| [`@nebulr-group/bridge-nestjs`](https://www.npmjs.com/package/@nebulr-group/bridge-nestjs) | NestJS |
| [`@nebulr-group/bridge-cli`](https://www.npmjs.com/package/@nebulr-group/bridge-cli) | CLI for people and AI agents |
| [`@nebulr-group/bridge-auth-core`](https://www.npmjs.com/package/@nebulr-group/bridge-auth-core) | Any JavaScript app (core) |

## License

[MIT](https://github.com/thebridgedev/bridge-express/blob/main/LICENSE) © Nebulr. Built by [The Bridge](https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-express).
