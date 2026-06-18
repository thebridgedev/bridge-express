# Configuration Reference

Bridge Express is configured with a single `createBridge(config)` call at startup. The `config` object is typed as `BridgeConfig`.

### BridgeConfig type

```typescript
interface BridgeConfig {
  /** Your Bridge application ID (required) */
  appId: string;

  /** Base URL for the Bridge API. All endpoints are derived from this.
   *  @default 'https://api.thebridge.dev' */
  apiBaseUrl?: string;

  /** Guard configuration (declarative route rules + default access) */
  guard?: GuardConfig;

  /** Enable debug logging (default: false) */
  debug?: boolean;

  /** Override the token-introspection URL for API token verification.
   *  API tokens are signed with a per-app HS256 secret this app never holds,
   *  so they are verified by POSTing them to the Bridge. Override when the
   *  process can't reach the public apiBaseUrl directly.
   *  @default {apiBaseUrl}/account/api-token/introspect */
  introspectionUrl?: string;

  /** How long (ms) a successful API-token introspection is cached, keyed by token.
   *  Trades revocation latency for fewer network calls.
   *  0 disables caching → every request introspects (instant revocation).
   *  @default 0 */
  introspectionCacheTtlMs?: number;

  /** Override the JWKS URL for user JWT verification.
   *  Useful when the process can't reach the public apiBaseUrl directly.
   *  @default {apiBaseUrl}/auth/.well-known/jwks.json */
  userJwksUrl?: string;
}
```

### Derived URLs

Everything is derived from `apiBaseUrl` (default `https://api.thebridge.dev`):

| Purpose | Derived URL | Override |
|---|---|---|
| User JWT verification (JWKS) | `{apiBaseUrl}/auth/.well-known/jwks.json` | `userJwksUrl` |
| Feature flag evaluation | `{apiBaseUrl}/cloud-views` | — |
| API token introspection | `{apiBaseUrl}/account/api-token/introspect` | `introspectionUrl` |
| Unified tenant surface | `{apiBaseUrl}/session/init` | — |

In most deployments you set only `appId` (and optionally `apiBaseUrl`). The `introspectionUrl` and `userJwksUrl` overrides exist for environments where the process reaches the Bridge over a private network address that differs from the public `apiBaseUrl`.

### Static configuration

```typescript
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
    ],
  },
});
```

### Configuration from environment variables

There's no async-factory ceremony — read environment variables directly when you build the config:

```typescript
import 'dotenv/config';
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  apiBaseUrl: process.env.BRIDGE_API_BASE_URL || undefined,
  debug: process.env.BRIDGE_DEBUG === 'true',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
    ],
  },
});
```

| Variable | Description | Default |
|----------|-------------|---------|
| `BRIDGE_APP_ID` | Your Bridge application ID | (required) |
| `BRIDGE_API_BASE_URL` | Bridge API base URL | `https://api.thebridge.dev` |
| `BRIDGE_DEBUG` | Enable debug logging | `false` |

Example `.env` file:

```env
BRIDGE_APP_ID=your-app-id-here
BRIDGE_DEBUG=true
```

### Route rules reference

Route rules govern the declarative `bridge.auth()` middleware. Each rule uses the `privilege` field to control access. Roles and feature flags are applied per route with `bridge.protect(...)`, **not** in route rules.

```typescript
interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;

  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers").
   *  Reserved — NOT wired in the Express plugin. */
  graphqlOperation?: string;

  /** Required privilege level for this route */
  privilege: RoutePrivilege;

  /** Optional plan restriction — tenant plan must be in this list */
  plans?: string[];
}
```

> **GraphQL operation rules are not wired in Express.** The `graphqlOperation` field exists in the type for cross-framework parity, but the Express plugin matches REST `path` patterns only. To protect a GraphQL endpoint, attach `bridge.protect(...)` to the `/graphql` route.

Path patterns support the `*` wildcard, which matches any characters (including `/`). For example `/reports/*` matches `/reports/summary` and `/reports/2024/q1`.

**Examples:**

```typescript
const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  guard: {
    defaultAccess: 'protected',
    rules: [
      // Public endpoints (no auth required)
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },

      // Any valid token (user JWT or API token)
      { path: '/api/status', privilege: 'AUTHENTICATED' },

      // Require a specific privilege in the user JWT
      { path: '/users/*', privilege: 'USER_READ' },
      { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },

      // Restrict by subscription plan
      { path: '/premium/*', privilege: 'AUTHENTICATED', plans: ['PREMIUM', 'ENTERPRISE'] },
    ],
  },
});
```

### RoutePrivilege type reference

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

### GuardConfig type reference

```typescript
interface GuardConfig {
  /** Default access level when no rule matches (default: 'protected') */
  defaultAccess?: 'public' | 'protected';

  /** Route rules for centralized configuration */
  rules?: RouteRule[];
}
```

Unlike a module-based framework, there is no `global` flag — the guard becomes "global" simply by mounting `bridge.auth()` with `app.use(...)`. Mount it on a sub-router to scope the declarative rules to a subtree of routes.

### Defaults

```typescript
const BRIDGE_DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  debug: false,
  defaultAccess: 'protected',
};
```
