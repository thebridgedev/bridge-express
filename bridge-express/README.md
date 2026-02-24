# @nebulr-group/bridge-express

Bridge authentication and authorization middleware for Express.js.

Provides JWT verification (JWKS), role-based access control (RBAC), feature flags, and HTTP token-forwarding — without any NestJS dependency.

## Installation

```bash
npm install @nebulr-group/bridge-express
```

**Peer dependencies:**
```bash
npm install express @types/express
```

## Quick Start

```typescript
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', public: true },
      { path: '/admin/*', role: 'ADMIN' },
    ],
  },
});

// Apply global auth middleware
app.use(bridge.auth());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/items', (req, res) => res.json({ user: req.bridgeUser }));
app.get('/admin/users', (req, res) => res.json({ users: [] }));

app.listen(3000);
```

## Configuration

`createBridge(config)` accepts a `BridgeConfig` object:

| Option | Type | Default | Description |
|---|---|---|---|
| `appId` | `string` | **required** | Your Bridge application ID |
| `authBaseUrl` | `string` | `https://auth.nblocks.cloud` | Bridge auth server base URL |
| `backendlessBaseUrl` | `string` | `https://backendless.nblocks.cloud` | Bridge backendless server base URL |
| `guard.defaultAccess` | `'public' \| 'protected'` | `'protected'` | Default access when no rule matches |
| `guard.rules` | `RouteRule[]` | `[]` | Route-level access rules |
| `debug` | `boolean` | `false` | Enable debug logging |

### Route Rules

```typescript
interface RouteRule {
  path: string;                      // Supports * wildcard
  public?: boolean;                  // No auth required
  role?: string;                     // Required role
  featureFlag?: FeatureFlagRequirement; // Required feature flag(s)
  methods?: HttpMethod[];            // Limit to specific HTTP methods
}
```

## Middleware

### `bridge.auth()` — Global Auth Middleware

Use at the app or router level. Reads config rules and `defaultAccess`:

```typescript
app.use(bridge.auth());
```

### `bridge.protect(options?)` — Per-Route Protection

Always enforces auth. Applies optional role/feature flag overrides:

```typescript
// Any authenticated user
router.get('/profile', bridge.protect(), handler);

// Require specific role
router.get('/admin', bridge.protect({ role: 'ADMIN' }), handler);

// Require feature flag
router.get('/beta', bridge.protect({ featureFlag: 'beta-access' }), handler);

// Require all flags
router.get('/premium', bridge.protect({ featureFlag: { all: ['premium-tier', 'active'] } }), handler);

// Require any flag
router.get('/special', bridge.protect({ featureFlag: { any: ['flag-a', 'flag-b'] } }), handler);
```

### `bridge.public()` — Skip Auth

Marks a route as public, bypassing `bridge.auth()`:

```typescript
router.get('/health', bridge.public(), handler);
```

## Request Fields

After successful auth, these fields are available on the request:

```typescript
req.bridgeUser        // BridgeUser — authenticated user info
req.bridgeTenant      // BridgeTenant | undefined — tenant info
req.bridgeAccessToken // string — raw JWT token
```

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
  const data = await bridge.http.get(
    'http://service-b/items',
    req.bridgeAccessToken,
  );
  res.json(data);
});
```

Available methods:
- `bridge.http.get(url, token?, options?)`
- `bridge.http.post(url, body, token?, options?)`
- `bridge.http.put(url, body, token?, options?)`
- `bridge.http.patch(url, body, token?, options?)`
- `bridge.http.delete(url, token?, options?)`

Throws `BridgeHttpError` (with `.status` and `.url`) on non-2xx responses.

## Feature Flags

Feature flags are evaluated via the Bridge backendless API with a 5-minute cache.

```typescript
// Single flag
bridge.protect({ featureFlag: 'beta-access' })

// All flags must be enabled
bridge.protect({ featureFlag: { all: ['premium-tier', 'active-subscription'] } })

// Any flag must be enabled
bridge.protect({ featureFlag: { any: ['flag-a', 'flag-b'] } })
```

## TypeScript

The package extends Express's `Request` type automatically:

```typescript
// Available after bridge.auth() or bridge.protect()
req.bridgeUser        // BridgeUser | undefined
req.bridgeTenant      // BridgeTenant | undefined
req.bridgeAccessToken // string | undefined
```

## License

MIT
