# Examples

End-to-end, copy-pasteable examples for the Bridge Express plugin. Every snippet is valid against the current API. For conceptual depth, follow the links to the topic guides.

- [Authentication & Access Control](../auth/auth.md)
- [Configuration](../configuration/configuration.md)
- [Feature Flags](../feature-flags/feature-flags.md)
- [Tenant Data — `bridge.fromJwt()`](../bridge-service/bridge-service.md)
- [Multi-Tenancy](../multi-tenancy/multi-tenancy.md)
- [Frontend Integration](../frontend-integration/frontend-integration.md)
- [Error Handling](../error-handling/error-handling.md)

## Installation

```bash
npm install @nebulr-group/bridge-express express
```

---

## 1. App setup with the declarative guard

```typescript
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  apiBaseUrl: process.env.BRIDGE_API_BASE_URL || undefined,
  debug: process.env.NODE_ENV === 'development',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
      { path: '/account/users', privilege: 'USER_READ' },
      { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
    ],
  },
});

// Mount the guard — every route below it is governed by the rules above.
app.use(bridge.auth());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3000, () => console.log('Server on http://localhost:3000'));
```

## 2. Reading the current user and tenant

```typescript
app.get('/me', (req, res) => {
  const user = req.bridgeUser!;
  const tenant = req.bridgeTenant;
  res.json({
    userId: user.id,
    email: user.email,
    role: user.role,
    tenantId: tenant?.id,
    tenantName: tenant?.name,
  });
});
```

## 3. Role-based access

```typescript
import { Router } from 'express';
const admin = Router();

// Applies to every route on this router
admin.use(bridge.protect({ role: 'ADMIN' }));

admin.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard', admin: req.bridgeUser!.email });
});

// Tighten one route to OWNER
admin.get('/settings', bridge.protect({ role: 'OWNER' }), (_req, res) => {
  res.json({ settings: 'sensitive data' });
});

app.use('/admin', admin);
```

## 4. API tokens, privileges, and accepted auth type

```typescript
// Dual-auth (default): API tokens must carry USER_READ; user JWTs bypass the privilege check.
app.get('/api/users', bridge.protect({ privilege: 'USER_READ' }), (req, res) => {
  if (req.bridgeApiToken) {
    return res.json({ users: [], via: 'api_token', appId: req.bridgeApiToken.appId });
  }
  return res.json({ users: [], via: 'jwt', tenantId: req.bridgeUser!.tenantId });
});

// Machine-to-machine: only an API token (x-api-key) is accepted; a user JWT alone gets 401.
app.post(
  '/integrations/sync',
  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
  (req, res) => {
    const { tenantId } = req.bridgeApiToken!;
    res.json({ synced: true, tenantId });
  },
);
```

## 5. Public routes

```typescript
// Force a route public even when defaultAccess is 'protected'
app.get('/health', bridge.public(), (_req, res) => {
  res.json({ status: 'ok' });
});
```

## 6. Feature flags

```typescript
// Single flag — 403 when disabled for the requesting user
app.get('/beta/feature', bridge.protect({ featureFlag: 'beta-access' }), (req, res) => {
  res.json({ feature: 'beta-data', user: req.bridgeUser });
});

// All flags must be enabled
app.get('/premium', bridge.protect({ featureFlag: { all: ['premium-tier', 'active-subscription'] } }), (_req, res) => {
  res.json({ premium: true });
});

// Any flag enables the route
app.get('/pro', bridge.protect({ featureFlag: { any: ['plan-pro', 'plan-enterprise'] } }), (_req, res) => {
  res.json({ pro: true });
});
```

See [Feature Flags](../feature-flags/feature-flags.md) for details.

## 7. Tenant data — subscription & entitlement gating

```typescript
app.get('/reports/export', async (req, res) => {
  const tenant = bridge.fromJwt(req.bridgeAccessToken!);

  if (!(await tenant.entitlements.can('pdf-export'))) {
    res.status(403).json({ error: 'Forbidden', message: 'Your plan does not include PDF export' });
    return;
  }

  const sub = await tenant.subscription; // { plan: { slug, name }, status, endsAt?, gateEngaged? }
  res.json({ report: 'export', plan: sub.plan.slug });
});
```

See [Tenant Data — `bridge.fromJwt()`](../bridge-service/bridge-service.md) for the full reference.

## 8. Token forwarding between services

```typescript
app.get('/items/from-service-b', async (req, res) => {
  // Forwards the verified user token so service-b authenticates the same user.
  const data = await bridge.http.get('http://service-b/items', req.bridgeAccessToken);
  res.json(data);
});
```

`bridge.http` throws `BridgeHttpError` on non-2xx responses:

```typescript
import { BridgeHttpError } from '@nebulr-group/bridge-express';

app.get('/data', async (req, res) => {
  try {
    const data = await bridge.http.get('http://service/data', req.bridgeAccessToken);
    res.json(data);
  } catch (err) {
    if (err instanceof BridgeHttpError) {
      res.status(err.status).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});
```

## 9. Public webhook handler (multi-tenant)

```typescript
import { Router } from 'express';
const router = Router();

router.post('/webhooks/bridge', bridge.public(), async (req, res) => {
  const { event, data } = req.body as { event: string; data: any };
  // Resolve the tenant from the event payload, then act on it.
  switch (event) {
    case 'TENANT_CREATED':
      // await tenants.create(data);
      break;
    // ...
  }
  res.json({ received: true });
});

app.use(router);
```

See [Multi-Tenancy](../multi-tenancy/multi-tenancy.md) for the full provisioning patterns.

## 10. RFC 6750 error responses

The middleware writes standard RFC 6750 `WWW-Authenticate` headers on 401:

```
# No Authorization header
401 Unauthorized
WWW-Authenticate: Bearer error="missing_token", error_description="No authorization token was provided"

# Token expired
401 Unauthorized
WWW-Authenticate: Bearer error="expired_token", error_description="The access token has expired"

# Invalid token
401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="The access token is invalid"

# Role / privilege / feature-flag failure
403 Forbidden
```

See [Error Handling](../error-handling/error-handling.md) for the full response shapes.
