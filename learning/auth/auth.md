# Authentication & Access Control

## Authentication

Bridge Express evaluates two independent authentication paths on every request:

1. **User JWT** — sent via `Authorization: Bearer <token>`. Verified against Bridge's JWKS endpoint. The standard path for browser-based users.
2. **API token** — sent via `x-api-key` as a JWT. Verified via Bridge token introspection (the app never holds the signing secret). The path for server-to-server / programmatic access.

The two paths are evaluated independently: when both an `x-api-key` and an `Authorization: Bearer` header are present and valid, both contexts coexist on the request (`req.bridgeApiToken` and `req.bridgeUser` are both set).

### Accessing user information

After a request authenticates via a user JWT, the verified user is on `req.bridgeUser`:

```typescript
import { Router } from 'express';

const router = Router();

router.get('/users/me', (req, res) => {
  const user = req.bridgeUser!;
  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    fullName: user.fullName,
    tenantId: user.tenantId,
    appId: user.appId,
    role: user.role,
  });
});

export default router;
```

The `BridgeUser` interface:

```typescript
interface BridgeUser {
  id: string;                    // User ID (sub claim)
  email: string;                 // User's email
  emailVerified: boolean;
  username: string;              // preferred_username claim
  fullName: string;              // Display name
  givenName?: string;
  familyName?: string;
  locale?: string;
  onboarded?: boolean;
  tenantId: string;              // Tenant/workspace ID
  appId?: string;                // App ID from the token (aid claim)
  scope?: string;                // OAuth scopes granted to the token
  role?: string;                 // User's role within the tenant
  multiTenantAccess?: boolean;
}
```

The user's `privileges` claim from the JWT is what the route-rule privilege check (below) evaluates against.

### Accessing tenant information

The tenant the user is authenticated for is on `req.bridgeTenant`:

```typescript
router.get('/workspace', (req, res) => {
  const user = req.bridgeUser!;
  const tenant = req.bridgeTenant;
  res.json({
    user: { id: user.id, email: user.email, role: user.role },
    tenant: tenant && {
      id: tenant.id,
      name: tenant.name,
      locale: tenant.locale,
      logo: tenant.logo,
      onboarded: tenant.onboarded,
    },
  });
});
```

The `BridgeTenant` interface:

```typescript
interface BridgeTenant {
  id: string;
  name: string;
  locale?: string;
  logo?: string;
  onboarded?: boolean;
}
```

### The raw access token

`req.bridgeAccessToken` holds the raw user JWT string. Use it to forward the token to downstream services (see [Frontend Integration](../frontend-integration/frontend-integration.md)) or to open a tenant scope (see [Tenant Data](../bridge-service/bridge-service.md)):

```typescript
const tenant = bridge.fromJwt(req.bridgeAccessToken!);
```

### Declarative vs per-route protection

#### Declarative guard (recommended)

Mount `bridge.auth()` as application- or router-level middleware. It reads the `guard` config and applies `defaultAccess` plus your route rules to every route registered after it:

```typescript
const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
});

app.use(bridge.auth());
```

With the declarative guard mounted, use `bridge.public()` to mark exceptions next to the handler:

```typescript
app.get('/health', bridge.public(), (_req, res) => {
  res.json({ status: 'ok' });
});
```

#### Per-route protection

`bridge.protect(options?)` always enforces auth on the route it's attached to, regardless of `defaultAccess`. It does **not** consult config route rules — its options *are* the rule. Use it to protect a single route, or to apply role / privilege / feature-flag / accepted-auth overrides:

```typescript
// Force auth on one route even if defaultAccess is 'public'
app.get('/secret', bridge.protect(), handler);

// Require an ADMIN role (user JWT)
app.delete('/admin/users/:id', bridge.protect({ role: 'ADMIN' }), handler);
```

You can mount `bridge.protect()` on a whole router to protect a group of routes:

```typescript
import { Router } from 'express';
const admin = Router();
admin.use(bridge.protect({ role: 'ADMIN' }));
admin.get('/dashboard', handler);  // all admin routes require ADMIN
admin.get('/settings', handler);
app.use('/admin', admin);
```

---

## API Token Authentication

### How it works

When an `x-api-key` header carries a JWT-shaped token, Bridge Express verifies it by POSTing it to the Bridge token-introspection endpoint (`{apiBaseUrl}/account/api-token/introspect`). The app never holds the HS256 signing secret — verification is a network call to the Bridge, not a local signature check. The Bridge collapses every rejection (forged, tampered, revoked, expired) into `{ active: false }`. On success, the claims are attached to `req.bridgeApiToken`.

> **User JWTs bypass the `privilege` option.** `bridge.protect({ privilege })` enforces the privilege only for API-token callers. User JWTs are governed by route-rule privilege, `role`, and `featureFlag` instead. This keeps an endpoint that adds a `privilege` option for API tokens from breaking user-JWT access.

### ApiTokenClaims type

When an API token verifies, `req.bridgeApiToken` is set with these claims:

```typescript
interface ApiTokenClaims {
  active: boolean;           // Whether the token is active (always true once attached)
  sub: string;               // Token subject identifier
  appId: string;             // App ID the token was issued for
  tenantId: string | null;   // Tenant ID (null for app-level tokens)
  type: 'api';               // Always 'api' for API tokens
  privileges: string[];      // Privilege strings (e.g. ['USER_READ', 'TENANT_WRITE'])
  exp?: number;              // Expiry (epoch seconds)
}
```

### Requiring a privilege

Pass `privilege` to `bridge.protect(...)` to require that an API token carries a specific privilege:

```typescript
// API tokens must carry USER_READ; user JWTs bypass this check.
router.get('/users', bridge.protect({ privilege: 'USER_READ' }), handler);

// API tokens must carry USER_WRITE.
router.post('/users', bridge.protect({ privilege: 'USER_WRITE' }), handler);
```

### Restricting the accepted auth type

`acceptAuth` restricts which credential types an endpoint accepts:

```typescript
// Only user JWTs accepted — an API token alone gets 401
bridge.protect({ acceptAuth: 'jwt' })

// Only API tokens accepted — a user JWT alone gets 401
bridge.protect({ acceptAuth: 'api_token' })

// Both accepted (default when omitted)
bridge.protect({ acceptAuth: 'both' })
```

The `AuthType` is `'jwt' | 'api_token' | 'both'`.

> When `acceptAuth: 'jwt'` and **both** headers are present (some Bridge frontends always send both), the request is accepted and the JWT path populates `req.bridgeUser`; the API key is treated as informational only. The endpoint is rejected only if the API token is the *only* credential offered.

### Dual-auth endpoints

Endpoints that accept both user JWTs and API tokens (the default). Branch on which context is present:

```typescript
router.get('/users', bridge.protect({ privilege: 'USER_READ' }), (req, res) => {
  if (req.bridgeApiToken) {
    // Authenticated via API token
    console.log('API token tenant:', req.bridgeApiToken.tenantId);
    console.log('API token privileges:', req.bridgeApiToken.privileges);
    return res.json({ users: [] });
  }

  // Authenticated via user JWT
  const user = req.bridgeUser!;
  return res.json({ users: [], tenantId: user.tenantId });
});
```

### API-token-only endpoints

Endpoints for machine-to-machine traffic only:

```typescript
router.post(
  '/integrations/sync',
  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
  (req, res) => {
    const { tenantId, privileges } = req.bridgeApiToken!;
    res.json({ synced: true, tenantId });
  },
);
```

### JWT-only endpoints

Endpoints that should reject API tokens:

```typescript
router.get('/account/profile', bridge.protect({ acceptAuth: 'jwt' }), (req, res) => {
  const user = req.bridgeUser!;
  res.json({ email: user.email, role: user.role });
});
```

---

## Role-Based Access Control

Roles are enforced per route via the `role` option on `bridge.protect(...)`. Roles are **not** part of route rules.

```typescript
import { Router } from 'express';
const admin = Router();

// Applies to every route on this router
admin.use(bridge.protect({ role: 'ADMIN' }));

admin.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard', admin: req.bridgeUser!.email });
});

// Tighten an individual route to OWNER
admin.get('/settings', bridge.protect({ role: 'OWNER' }), (req, res) => {
  res.json({ settings: 'sensitive data' });
});

app.use('/admin', admin);
```

The role check compares `req.bridgeUser.role` (from the verified user JWT) against the required role and returns 403 on mismatch. The role option applies only to the user-JWT path; API-token callers are unaffected by it.

> **A note on GraphQL.** Express has no built-in GraphQL execution context. Protect a `/graphql` route with `bridge.protect(...)` like any other route. Per-operation `graphqlOperation` rules exist in the config type but are **not wired** in the Express plugin — do not rely on per-operation GraphQL guarding here.
