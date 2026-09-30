# Authentication & Access Control

## Authentication

Bridge Express evaluates two independent authentication paths on every request:

1. **User JWT**: sent via `Authorization: Bearer <token>`. Verified against Bridge's JWKS endpoint. The standard path for browser-based users.
2. **API token**: sent via `x-api-key` as a JWT. Verified via Bridge token introspection (the app never holds the signing secret). The path for server-to-server / programmatic access.

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
  privileges?: string[];         // Privilege strings from the JWT privileges claim
  multiTenantAccess?: boolean;
}
```

The user's `privileges` claim is what a flag rule such as `privileges contains "USER_WRITE"` evaluates against. App code reads `role` / `privileges` for display, never to decide access; that is a flag (see [Role-based access](#role-based-access-control)).

### Accessing workspace information

The workspace the user is authenticated for (a workspace is called a *tenant* in the API, which is why the identifiers below say `tenant`) is on `req.bridgeTenant`:

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

`req.bridgeAccessToken` holds the raw user JWT string. Use it to forward the token to downstream services (see [Frontend Integration](../frontend-integration/frontend-integration.md)). To open a tenant scope, use `bridge.fromRequest(req)`, which reuses the token the middleware verified (see [Tenant Data](../bridge-service/bridge-service.md)):

```typescript
const tenant = bridge.fromRequest(req);
```

### Declarative vs per-route protection

#### Declarative guard (recommended)

Mount `bridge.auth()` as app- or router-level middleware. It reads the `guard` config and applies `defaultAccess` plus your route rules to every route registered after it:

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

`bridge.protect(options?)` always enforces auth on the route it's attached to, regardless of `defaultAccess`. It does **not** consult config route rules; its options *are* the rule. Use it to protect a single route, or to apply feature-flag / API-token privilege / accepted-auth overrides:

```typescript
// Force auth on one route even if defaultAccess is 'public'
app.get('/secret', bridge.protect(), handler);

// Who may delete users is a flag (rule: privileges contains "USER_WRITE")
app.delete('/admin/users/:id', bridge.protect({ featureFlag: 'manage-users' }), handler);
```

You can mount `bridge.protect()` on a whole router to protect a group of routes:

```typescript
import { Router } from 'express';
const admin = Router();
admin.use(bridge.protect({ featureFlag: 'admin-area' }));
admin.get('/dashboard', handler);  // all admin routes need the admin-area flag
admin.get('/settings', handler);
app.use('/admin', admin);
```

---

## API Token Authentication

### How it works

When an `x-api-key` header carries a JWT-shaped token, Bridge Express verifies it by POSTing it to the Bridge token-introspection endpoint (`{apiBaseUrl}/account/api-token/introspect`). The app never holds the HS256 signing secret; verification is a network call to the Bridge, not a local signature check. The Bridge collapses every rejection (forged, tampered, revoked, expired) into `{ active: false }`. On success, the claims are attached to `req.bridgeApiToken`.

> **`privilege` is API tokens only.** `bridge.protect({ privilege })` is an API token's scope, for machine callers. It is not a gate on a person: a user JWT is not checked against it. Signed-in people are gated with `featureFlag`.

### ApiTokenClaims type

When an API token verifies, `req.bridgeApiToken` is set with these claims:

```typescript
interface ApiTokenClaims {
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
// Only user JWTs accepted; an API token alone gets 401
bridge.protect({ acceptAuth: 'jwt' })

// Only API tokens accepted; a user JWT alone gets 401
bridge.protect({ acceptAuth: 'api_token' })

// Both accepted (default when omitted)
bridge.protect({ acceptAuth: 'both' })
```

The `AuthType` is `'jwt' | 'api_token' | 'both'`.

> When `acceptAuth: 'jwt'` and **both** headers are present (some Bridge frontends always send both), the request is accepted and the JWT path populates `req.bridgeUser`; the API key is treated as informational only. The request is rejected only if the API token is the *only* credential offered.

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

**Every gate is a flag.** Who may reach a route is `bridge.protect({ featureFlag })` (or a route rule's `featureFlag`), and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.<key> eq true`) or a rollout. Prefer a privilege rule over a role rule; write `user.role eq "ADMIN"` only when you mean the role itself.

```typescript
import { Router } from 'express';
const admin = Router();

// Applies to every route on this router. Flag rule: privileges contains "USER_WRITE"
admin.use(bridge.protect({ featureFlag: 'admin-area' }));

admin.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard', admin: req.bridgeUser!.email });
});

app.use('/admin', admin);

// Stricter route. Flag rule: privileges contains "TENANT_WRITE"
app.get('/billing/account', bridge.protect({ featureFlag: 'manage-billing' }), (req, res) => {
  res.json({ settings: 'sensitive data' });
});
```

A refused request gets 403 `FEATURE_NOT_PERMITTED` (or `FEATURE_OFF`) naming the flag, or 402 `FEATURE_NOT_IN_PLAN` when only an upgrade would turn it on. Flags apply to the user-JWT path; scope API-token callers with `privilege`.

The `role`, `plans`, `entitlement` and `entitlements` options were removed: passing one to `bridge.protect(...)`, or putting one on a route rule, stops the app at startup with an error naming the flag to use instead. Run `npx @nebulr-group/bridge-cli check gates` to list every direct role, privilege or plan check left in the code. Numbers (how many tickets a plan allows) are plan limits, not flags: see [Plan limits](../plan-limits/plan-limits.md).

> **A note on GraphQL.** Express has no built-in GraphQL execution context. Protect a `/graphql` route with `bridge.protect(...)` like any other route. Per-operation `graphqlOperation` rules exist in the config type but are **not wired** in the Express plugin. Do not rely on per-operation GraphQL guarding here.
