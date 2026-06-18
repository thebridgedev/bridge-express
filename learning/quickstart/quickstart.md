# Bridge Express Quickstart Guide

Get started with The Bridge Express plugin for backend authentication, privilege-based access control, API token support, and feature flags.

## Install the plugin

```bash
npm install @nebulr-group/bridge-express express
```

## Basic setup

Create a single `bridge` instance at startup with your `appId`, then mount its middleware:

```typescript
// src/app.ts
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

const bridge = createBridge({
  appId: 'YOUR_APP_ID',
});

app.listen(3000, () => console.log('Server on http://localhost:3000'));
```

There are no modules and no dependency injection — `createBridge(config)` returns a `bridge` instance whose methods (`auth()`, `protect()`, `public()`, `fromJwt()`, `http`) you use directly.

## Global guard with route rules

For most applications, enable the declarative guard with route rules. Mount `bridge.auth()` as application-level middleware. It reads the `guard` config: it protects every route by default (`defaultAccess: 'protected'`) and lets you define exceptions using the `privilege` field:

```typescript
// src/app.ts
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  debug: true, // Enable for development
  guard: {
    defaultAccess: 'protected',
    rules: [
      // Public routes (no auth required)
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },

      // Require specific privileges
      { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },
      { path: '/users/*', privilege: 'USER_READ' },

      // Restrict by subscription plan
      { path: '/premium/*', privilege: 'AUTHENTICATED', plans: ['PREMIUM', 'ENTERPRISE'] },
    ],
  },
});

// Mount the guard. Every route registered after this is governed by the rules above.
app.use(bridge.auth());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
```

All routes are now protected by default, with the exceptions you defined.

> **Note:** Role-based access (`bridge.protect({ role })`) and feature-flag gating (`bridge.protect({ featureFlag })`) are applied per route with `bridge.protect(...)`, not in route rules. See the [feature flags documentation](../feature-flags/feature-flags.md) for details.

## Accessing the authenticated user

Once a request is authenticated, the verified user is attached to the Express `Request` as `req.bridgeUser`:

```typescript
// src/routes/items.ts
import { Router } from 'express';

const router = Router();

router.get('/items', (req, res) => {
  const user = req.bridgeUser!;
  console.log('User:', user.email);
  console.log('Tenant:', user.tenantId);
  console.log('Role:', user.role);
  res.json({ items: [], requestedBy: user.email });
});

export default router;
```

`req.bridgeUser` is typed as `BridgeUser`. Bridge Express augments the Express `Request` type, so `req.bridgeUser`, `req.bridgeTenant`, `req.bridgeAccessToken`, and `req.bridgeApiToken` are all available without extra typing.

## Accessing tenant information

The tenant the user is authenticated for is on `req.bridgeTenant`:

```typescript
router.get('/workspace', (req, res) => {
  const user = req.bridgeUser!;
  const tenant = req.bridgeTenant;
  res.json({
    userId: user.id,
    tenantId: tenant?.id,
    tenantName: tenant?.name,
  });
});
```

## Public routes

Mark a specific route public with `bridge.public()`. This overrides the guard's `defaultAccess` and any route rule for that route:

```typescript
app.get('/health', bridge.public(), (_req, res) => {
  res.json({ status: 'ok' });
});
```

Either approach works — a `{ path: '/health', privilege: 'ANONYMOUS' }` rule in config, or `bridge.public()` on the route itself. Use `bridge.public()` when you want the decision to live next to the handler.

## API token authentication

The plugin supports API token authentication alongside user JWTs. API tokens are sent via the `x-api-key` header and carry their own privilege claims. They are verified by Bridge token introspection — your app never holds the signing secret.

Use `bridge.protect({ privilege })` to require an API token privilege, and `acceptAuth` to restrict which credential types an endpoint accepts:

```typescript
// Accept both user JWTs and API tokens (default).
// API tokens must carry USER_READ; user JWTs bypass the privilege option.
router.get('/api/users', bridge.protect({ privilege: 'USER_READ' }), (req, res) => {
  const apiToken = req.bridgeApiToken; // set when authenticated via x-api-key
  const user = req.bridgeUser;         // set when authenticated via Bearer token
  res.json({ users: [] });
});

// Only accept API tokens — a user JWT alone gets 401.
router.post(
  '/integrations/sync',
  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
  (req, res) => {
    res.json({ synced: true, appId: req.bridgeApiToken?.appId });
  },
);
```

For full API token documentation, see [Authentication & Access Control](../auth/auth.md#api-token-authentication).

## Next steps

You now have backend authentication set up. The middleware will:

1. Validate user JWTs from `Authorization: Bearer <token>` headers (verified against Bridge's JWKS endpoint)
2. Validate API tokens from `x-api-key` headers (verified via Bridge token introspection)
3. Attach user and tenant information to each request (`req.bridgeUser`, `req.bridgeTenant`, `req.bridgeApiToken`)
4. Enforce privilege, role, and feature flag requirements
5. Return RFC 6750-compliant 401/403 responses on failure

For detailed examples including role-based access, feature flags, API token patterns, and multi-tenancy, see the [examples documentation](../examples/examples.md).
