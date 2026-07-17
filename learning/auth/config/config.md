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

There's no async-factory ceremony. Read environment variables directly when you build the config:

```typescript
import 'dotenv/config';
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  apiBaseUrl: process.env.BRIDGE_API_BASE_URL || undefined,
  debug: process.env.BRIDGE_DEBUG === 'true',
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
| `appId` | `string` | (required) | Your Bridge app ID |
| `apiBaseUrl` | `string` | `https://api.thebridge.dev` | Base URL for the Bridge API. All other endpoints are derived from this. |
| `guard` | `GuardConfig` | (none) | Declarative route rules + default access; see [Route guards](/auth/securing/route-guards/) |
| `debug` | `boolean` | `false` | Enable debug logging |
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

Route rules govern the declarative `bridge.auth()` middleware. Roles and feature flags are applied per route with `bridge.protect(...)`, **not** in route rules; see [Route guards](/auth/securing/route-guards/).

| Field | Type | Description |
|---|---|---|
| `path` | `string` | REST URL wildcard pattern (e.g. `/account/subscription/*`). `*` matches any characters, including `/`. |
| `graphqlOperation` | `string` | GraphQL operation name. Present on the type for cross-framework parity; **not wired** in the Express plugin. |
| `privilege` | `RoutePrivilege` (required) | Required privilege level for this route. |
| `plans` | `string[]` | Declared on the type but **not yet enforced** by the middleware; a matching rule's `plans` list is currently ignored. For plan-based gating that actually blocks requests, use entitlement checks via `bridge.fromJwt(...)` (see [Tenant Data](../../bridge-service/bridge-service.md)). |

### RoutePrivilege reference

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // No authentication required
  | 'AUTHENTICATED'   // Any valid credential (user JWT or API token)
  | 'USER_READ'       // Requires USER_READ in the user JWT privileges claim
  | 'USER_WRITE'      // Requires USER_WRITE in the user JWT privileges claim
  | 'TENANT_READ'     // Requires TENANT_READ in the user JWT privileges claim
  | 'TENANT_WRITE'    // Requires TENANT_WRITE in the user JWT privileges claim
  | string;           // Any custom privilege string
```

A specific privilege (anything other than `ANONYMOUS` / `AUTHENTICATED`) requires that string to appear in the user JWT's `privileges` claim.

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
- **MCP:** not yet available; coming soon.
