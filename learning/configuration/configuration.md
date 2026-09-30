# Configuration Reference

Bridge Express is configured with a single `createBridge(config)` call at startup. The `config` object is typed as `BridgeConfig`.

### BridgeConfig type

```typescript
interface BridgeConfig {
  /** Your Bridge application ID.
   *  @default process.env.BRIDGE_APP_ID (one of the two is required) */
  appId?: string;

  /** Base URL for the Bridge API. All endpoints are derived from this.
   *  @default process.env.BRIDGE_API_BASE_URL, else 'https://api.thebridge.dev' */
  apiBaseUrl?: string;

  /** Guard configuration (declarative route rules + default access) */
  guard?: GuardConfig;

  /** Enable debug logging.
   *  @default process.env.BRIDGE_DEBUG === 'true' */
  debug?: boolean;

  /** Where a refused request tells the user to upgrade: `fix` in
   *  402 FEATURE_NOT_IN_PLAN / 402 QUOTA_EXCEEDED / 403 ENTITLEMENT_REQUIRED.
   *  @default { manageRoute: '/subscription' } */
  billing?: { manageRoute?: string };

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
| Feature flag evaluation | `{apiBaseUrl}/cloud-views` | (none) |
| API token introspection | `{apiBaseUrl}/account/api-token/introspect` | `introspectionUrl` |
| Unified tenant surface | `{apiBaseUrl}/session/init` | (none) |

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

`createBridge()` fills `appId`, `apiBaseUrl` and `debug` from the environment when you leave them out. An explicit option wins (including `debug: false` over `BRIDGE_DEBUG=true`), then the environment, then the default. With no app id either way, `createBridge()` throws at startup.

```typescript
import 'dotenv/config';
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({
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
| `BRIDGE_APP_ID` | Your Bridge app ID | (required) |
| `BRIDGE_API_BASE_URL` | Bridge API base URL | `https://api.thebridge.dev` |
| `BRIDGE_DEBUG` | Enable debug logging | `false` |

Example `.env` file:

```env
BRIDGE_APP_ID=your-app-id-here
BRIDGE_DEBUG=true
```

### Route rules reference

Route rules govern the declarative `bridge.auth()` middleware; `bridge.protect(...)` never reads them. A rule says whether a route needs a signed-in caller, and which flag decides who gets it.

```typescript
interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;

  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers").
   *  Reserved; NOT wired in the Express plugin. */
  graphqlOperation?: string;

  /** Whether the route needs a signed-in caller */
  privilege: RoutePrivilege;

  /** The flag that decides who gets this route. Its rule says why:
   *  a privilege, a plan feature or a rollout. */
  featureFlag?: FeatureFlagRequirement; // string | { any: string[] } | { all: string[] }
}
```

> **GraphQL operation rules are not wired in Express.** The `graphqlOperation` field exists in the type for cross-framework parity, but the Express plugin matches REST `path` patterns only. To protect a GraphQL endpoint, attach `bridge.protect(...)` to the `/graphql` route.

> **Every gate is a flag.** A rule with any privilege other than `ANONYMOUS` / `AUTHENTICATED`, or with the removed `plans`, `entitlement`, `entitlements` or `role` fields, stops the app at startup with an error naming the flag setup to use instead. Plan limits (numbers) are separate middleware: see [Plan limits](../plan-limits/plan-limits.md).

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

      // Who gets these is a flag; its rule names the privilege
      // (e.g. `privileges contains "USER_READ"`)
      { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/account/subscription/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-billing' },
    ],
  },
});
```

### RoutePrivilege type reference

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // No authentication required
  | 'AUTHENTICATED';  // Any valid credential (user JWT or API token)
```

Anything finer than "signed in" is a flag with a rule on a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.<key> eq true`) or a rollout. An API token's scope is `bridge.protect({ privilege })` (API tokens only).

### GuardConfig type reference

```typescript
interface GuardConfig {
  /** Default access level when no rule matches (default: 'protected') */
  defaultAccess?: 'public' | 'protected';

  /** Route rules for centralized configuration */
  rules?: RouteRule[];
}
```

Unlike a module-based framework, there is no `global` flag; the guard becomes "global" simply by mounting `bridge.auth()` with `app.use(...)`. Mount it on a sub-router to scope the declarative rules to a subtree of routes.

### Defaults

```typescript
const BRIDGE_DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  debug: false,
  defaultAccess: 'protected',
};
```
