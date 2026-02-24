# Bridge Express — Examples

## Installation & Setup

```bash
npm install @nebulr-group/bridge-express express
```

## Express Setup Quickstart

```typescript
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  authBaseUrl: process.env.BRIDGE_AUTH_BASE_URL,
  debug: process.env.NODE_ENV === 'development',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', public: true },
      { path: '/admin/*', role: 'ADMIN' },
      { path: '/beta/*', featureFlag: 'beta-access' },
    ],
  },
});

// Global auth — reads config rules
app.use(bridge.auth());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/items', (req, res) => {
  res.json({
    items: [],
    requestedBy: req.bridgeUser?.email,
  });
});

app.get('/admin/users', (req, res) => {
  res.json({ users: [] });
});

app.listen(3000, () => console.log('Server on http://localhost:3000'));
```

## Per-Route Protection

```typescript
// Force auth on a specific route (ignores defaultAccess: 'public')
router.get('/secret', bridge.protect(), handler);

// Require ADMIN role
router.delete('/admin/user/:id', bridge.protect({ role: 'ADMIN' }), handler);

// Require feature flag
router.get('/new-dashboard', bridge.protect({ featureFlag: 'new-ui' }), handler);

// Make a route public even when defaultAccess is 'protected'
router.get('/open', bridge.public(), handler);
```

## Accessing User and Tenant

```typescript
app.get('/profile', (req, res) => {
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

## Token Forwarding with `bridge.http`

Forward the authenticated user's JWT to a downstream microservice:

```typescript
app.get('/aggregated', async (req, res) => {
  // Token is forwarded automatically as Authorization: Bearer <token>
  const [orders, profile] = await Promise.all([
    bridge.http.get('http://orders-service/orders', req.bridgeAccessToken),
    bridge.http.get('http://profile-service/me', req.bridgeAccessToken),
  ]);

  res.json({ orders, profile });
});

// POST with body and token
app.post('/orders', async (req, res) => {
  const order = await bridge.http.post(
    'http://orders-service/orders',
    req.body,
    req.bridgeAccessToken,
  );
  res.json(order);
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

## Feature Flag Requirements

```typescript
// Single flag
bridge.protect({ featureFlag: 'beta-access' })

// All flags must be enabled
bridge.protect({ featureFlag: { all: ['premium', 'active-subscription'] } })

// Any flag must be enabled
bridge.protect({ featureFlag: { any: ['plan-pro', 'plan-enterprise'] } })
```

## RFC 6750 Error Responses

The middleware returns standard RFC 6750 `WWW-Authenticate` headers:

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

# Role mismatch / feature flag disabled
403 Forbidden
```
