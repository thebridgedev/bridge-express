# Examples

End-to-end, copy-pasteable examples for the Bridge Express plugin. Every snippet is valid against the current API. For conceptual depth, follow the links to the topic guides.

- [Authentication and access control](../auth/auth.md)
- [Configuration](../configuration/configuration.md)
- [Feature flags](../feature-flags/feature-flags.md)
- [Tenant data via `bridge.fromRequest()`](../bridge-service/bridge-service.md)
- [Plan limits](../plan-limits/plan-limits.md)
- [Multi-tenancy](../multi-tenancy/multi-tenancy.md)
- [Frontend integration](../frontend-integration/frontend-integration.md)
- [Error handling](../error-handling/error-handling.md)

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

// appId / apiBaseUrl / debug come from BRIDGE_APP_ID / BRIDGE_API_BASE_URL / BRIDGE_DEBUG
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
      // Who gets these is a flag; its rule names the privilege
      { path: '/account/users', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
    ],
  },
});

// Mount the guard. Every route below it is governed by the rules above.
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

## 3. Admin area: every gate is a flag

```typescript
import { Router } from 'express';
const admin = Router();

// Applies to every route on this router. Flag rule: privileges contains "USER_WRITE"
admin.use(bridge.protect({ featureFlag: 'admin-area' }));

admin.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard', admin: req.bridgeUser!.email });
});

// Tighten one route. Flag rule: privileges contains "TENANT_WRITE"
admin.get('/settings', bridge.protect({ featureFlag: 'admin-settings' }), (_req, res) => {
  res.json({ settings: 'sensitive data' });
});

app.use('/admin', admin);
```

## 4. API tokens, privileges, and accepted auth type

```typescript
// Dual-auth (default): API tokens must carry USER_READ. `privilege` is API tokens only.
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
// Single flag: 403 FEATURE_NOT_PERMITTED / FEATURE_OFF (or 402 FEATURE_NOT_IN_PLAN) when off
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

See [Feature flags](../feature-flags/feature-flags.md) for details.

## 7. Plan limits and plan features

```typescript
// A plan feature is a flag: list `pdf-export` on the plans that sell it and rule
// the flag `bridge:billing.entitlement.pdf-export eq true`. Without it: 402 FEATURE_NOT_IN_PLAN.
// How many is the quota: 402 QUOTA_EXCEEDED at the limit, one event recorded after a 2xx.
app.post(
  '/reports/export',
  bridge.protect({ featureFlag: 'pdf-export' }),
  bridge.requireQuota('exports'),
  async (req, res) => {
    const sub = await bridge.fromRequest(req).subscription; // { plan: { slug, name }, status, ... }
    res.json({ report: 'export', plan: sub.plan.slug });
  },
);
```

See [Plan limits](../plan-limits/plan-limits.md) and [Tenant data](../bridge-service/bridge-service.md) for the full reference.

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

See [Multi-tenancy](../multi-tenancy/multi-tenancy.md) for the full provisioning patterns.

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

See [Error handling](../error-handling/error-handling.md) for the full response shapes.
