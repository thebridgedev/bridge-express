---
title: Configurations
description: The BridgeConfig options you pass to createBridge, and the app settings managed in Control Center.
sidebar:
  label: Express
---

# Configurations

Bridge Express is configured with a single `createBridge(config)` call at startup. There are no modules, no decorators, no dependency injection. The `config` object is typed as `BridgeConfig`.

## Passing config to Bridge

```typescript
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
  },
});

app.use(bridge.auth());
```

### Configuration from environment variables

`createBridge()` reads `appId`, `apiBaseUrl` and `debug` from the environment when you leave them out. An explicit option always wins (including `debug: false` over `BRIDGE_DEBUG=true`), then the environment, then the default. With no app id either way, `createBridge()` throws at startup.

```typescript
import 'dotenv/config';
import { createBridge } from '@nebulr-group/bridge-express';

// BRIDGE_APP_ID / BRIDGE_API_BASE_URL / BRIDGE_DEBUG fill in what is not passed
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
  },
});
```

| Variable | Description | Default |
|----------|-------------|---------|
| `BRIDGE_APP_ID` | Your Bridge app ID | (required) |
| `BRIDGE_API_BASE_URL` | Bridge API base URL | `https://api.thebridge.dev` |
| `BRIDGE_DEBUG` | Enable debug logging | `false` |

```env
BRIDGE_APP_ID=your-app-id-here
BRIDGE_DEBUG=true
```

## BridgeConfig reference

| Option | Type | Default | Description |
|---|---|---|---|
| `appId` | `string` | `BRIDGE_APP_ID` (one of the two is required) | Your Bridge app ID |
| `apiBaseUrl` | `string` | `BRIDGE_API_BASE_URL`, else `https://api.thebridge.dev` | Base URL for the Bridge API. All other endpoints are derived from this. |
| `guard` | `GuardConfig` | (none) | Declarative route rules + default access; see [Route guards](/auth/securing/route-guards/) |
| `debug` | `boolean` | `BRIDGE_DEBUG === 'true'`, else `false` | Enable debug logging |
| `billing.manageRoute` | `string` | `/subscription` | Your subscription page; sent as `fix` in `402 FEATURE_NOT_IN_PLAN`, `402 QUOTA_EXCEEDED` and `403 ENTITLEMENT_REQUIRED` refusals |
| `introspectionUrl` | `string` | `{apiBaseUrl}/account/api-token/introspect` | Override the API-token introspection endpoint, for environments where the process reaches Bridge over a private network address that differs from the public `apiBaseUrl` |
| `introspectionCacheTtlMs` | `number` | `0` | How long (ms) a successful API-token introspection is cached, keyed by token. `0` disables caching, so every request introspects (instant revocation); raise it to trade revocation latency for fewer network calls. |
| `userJwksUrl` | `string` | `{apiBaseUrl}/auth/.well-known/jwks.json` | Override the JWKS URL for user-JWT verification; same private-network use case as `introspectionUrl` |

### Derived URLs

Everything is derived from `apiBaseUrl` unless overridden:

| Purpose | Derived URL | Override |
|---|---|---|
| User JWT verification (JWKS) | `{apiBaseUrl}/auth/.well-known/jwks.json` | `userJwksUrl` |
| Feature flag evaluation | `{apiBaseUrl}/cloud-views` | (none) |
| API token introspection | `{apiBaseUrl}/account/api-token/introspect` | `introspectionUrl` |
| Unified tenant surface (`bridge.fromJwt()`) | `{apiBaseUrl}/session/init` | (none) |

In most deployments you set only `appId` (and optionally `apiBaseUrl`). The `introspectionUrl` and `userJwksUrl` overrides exist specifically for environments (Docker, private VPCs) where the process reaches the Bridge over an address that differs from the public `apiBaseUrl`.

### Defaults

```typescript
const BRIDGE_DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  debug: false,
  defaultAccess: 'protected',
};
```

## Route rules reference

Route rules govern the declarative `bridge.auth()` middleware; `bridge.protect(...)` never reads them. See [Route guards](/auth/securing/route-guards/).

| Field | Type | Description |
|---|---|---|
| `path` | `string` | REST URL wildcard pattern (e.g. `/account/subscription/*`). `*` matches any characters, including `/`. |
| `graphqlOperation` | `string` | GraphQL operation name. Present on the type for cross-framework parity; **not wired** in the Express plugin. |
| `privilege` | `RoutePrivilege` (required) | Whether the route needs a signed-in caller. |
| `featureFlag` | `string \| { any: string[] } \| { all: string[] }` | The flag that decides who gets the route. Its rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.<key> eq true`) or a rollout. |

### RoutePrivilege reference

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // No authentication required
  | 'AUTHENTICATED';  // Any valid credential (user JWT or API token)
```

Anything finer than "signed in" is a flag. A rule with any other privilege string, or with the removed `plans`, `entitlement`, `entitlements` or `role` fields, stops the app at startup with an error naming the flag setup to use instead. An API token's scope is `bridge.protect({ privilege })` on the route (API tokens only).

### GuardConfig reference

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultAccess` | `'public' \| 'protected'` | `'protected'` | Access level when no rule matches |
| `rules` | `RouteRule[]` | `[]` | Centralized route rules |

Unlike a module-based framework, there is no `global` flag; the guard becomes "global" simply by mounting `bridge.auth()` with `app.use(...)`. Mount it on a sub-router instead to scope the declarative rules to a subtree of routes.

## Configs managed in Control Center

Some settings aren't passed to `createBridge(...)` at all. They're set once per app in Control Center (your admin dashboard at app.thebridge.dev) or via the CLI, and Bridge enforces them server-side regardless of which SDK is talking to it:

| Setting | What it does |
|---------|---------------|
| Redirect URIs | The allowlist of callback URLs Bridge is allowed to redirect a frontend sign-in flow to. |
| Allowed origins | The CORS allowlist: origins permitted to call the Bridge API directly from a browser. |
| Default callback URL | Used whenever a frontend doesn't pass an explicit callback URL in code. |
| SSO providers | Federation connections (Google, Azure AD, etc.) available to the sign-in flow. |

These matter to an Express backend indirectly: your `appId` ties this backend to the same app record these settings live on, so the JWKS/introspection endpoints your middleware calls, and the tokens your frontend obtains, are all scoped consistently to one app configuration.

```bash
bridge app update \
  --redirect-uris "https://app.example.com/oauth-callback,https://admin.example.com/oauth-callback" \
  --allowed-origins "https://app.example.com,https://admin.example.com" \
  --default-callback-uri "https://app.example.com/oauth-callback"

bridge setup sso --provider google --client-id <clientId> --client-secret <clientSecret>
```

- **Control Center:** the same settings, managed from your app's settings.
- **MCP (AI-assistant integration):** connect your AI assistant to `https://api.thebridge.dev/mcp` as a remote MCP server (sign in and approve access to your app in the browser when it asks). Its `add_redirect_uri` and `remove_redirect_uri` tools change redirect URIs one at a time, `update_app` sets allowed origins (the list you pass replaces the whole list) and the default callback URL, and `setup_sso` saves an SSO provider's credentials and turns it on.
