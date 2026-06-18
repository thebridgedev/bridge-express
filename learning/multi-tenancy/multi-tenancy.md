# Multi-Tenancy Patterns

> Looking for the current tenant's subscription, entitlements, or branding inside a request? See
> [Tenant Data — `bridge.fromJwt()`](../bridge-service/bridge-service.md).

Every authenticated request carries a tenant. The verified tenant ID is available as `req.bridgeUser.tenantId` (and `req.bridgeTenant.id`). The patterns below cover how to keep each tenant's data separate and how to provision tenant records in your own database.

### Data separation strategies

**1. Column-based separation (recommended for most cases)**

Add a `tenantId` column to your tables and filter every query by it:

```typescript
// Pseudocode model — use your ORM/driver of choice (Prisma, Knex, TypeORM, raw SQL).
interface Item {
  id: string;
  tenantId: string;   // every row belongs to exactly one tenant
  name: string;
  createdBy: string;
}
```

**2. Schema-based separation** — separate database schema per tenant (more isolation, more complexity).

**3. Database-based separation** — completely separate databases per tenant (maximum isolation, highest complexity).

### Just-in-Time (JIT) provisioning

When you see a new tenant/user ID in a request, create the record automatically:

```typescript
async function ensureTenant(tenantId: string, tenantName: string): Promise<Tenant> {
  let tenant = await db.tenants.findById(tenantId);

  if (!tenant) {
    tenant = await db.tenants.insert({
      id: tenantId,
      name: tenantName,
      createdAt: new Date(),
    });
    await setupDefaultData(tenant);
  }

  return tenant;
}
```

Call it from a route (or a small middleware) using the verified tenant from the token:

```typescript
router.use(async (req, _res, next) => {
  const user = req.bridgeUser;
  if (user) {
    await ensureTenant(user.tenantId, req.bridgeTenant?.name ?? '');
  }
  next();
});
```

### Webhook-based provisioning

Bridge sends webhooks when tenants and users are created:

- `TENANT_CREATED` — new workspace/account created
- `TENANT_UPDATED` — workspace details changed
- `TENANT_USER_CREATED` — new user added to workspace
- `TENANT_USER_UPDATED` — user details changed
- `TENANT_USER_DELETED` — user removed from workspace

Handle them on a **public** route (webhooks carry no user JWT):

```typescript
import { Router } from 'express';

const router = Router();

// bridge.public() (or a { path: '/webhooks/*', privilege: 'ANONYMOUS' } rule)
// makes this reachable without a user token.
router.post('/webhooks/bridge', bridge.public(), async (req, res) => {
  const { event, data } = req.body as { event: string; data: any; timestamp: string };

  switch (event) {
    case 'TENANT_CREATED':
      await tenants.create(data);
      break;
    case 'TENANT_USER_CREATED':
      await users.create(data);
      break;
    // ... handle other events
  }

  res.json({ received: true });
});

export default router;
```

Make the webhook endpoint public either with `bridge.public()` on the route (as above) or with a config rule:

```typescript
const bridge = createBridge({
  appId: 'YOUR_APP_ID',
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
});
```

> **Verify the webhook signature.** A public route is reachable by anyone. Validate the `x-webhook-signature` header against your Bridge webhook secret before acting on the payload.

### Recommended pattern: Webhooks + JIT fallback

The most robust approach combines both methods — webhooks as the primary provisioning path, JIT as a fallback if a request beats the webhook:

```typescript
// Called from the webhook — primary provisioning path
async function createTenant(data: { id: string; name: string; plan?: string }): Promise<Tenant> {
  const existing = await db.tenants.findById(data.id);
  if (existing) return existing; // JIT already handled it

  const tenant = await db.tenants.insert({
    ...data,
    provisionedVia: 'webhook',
    createdAt: new Date(),
  });
  await setupDefaultData(tenant);
  return tenant;
}

// Called on each request — JIT fallback
async function ensureTenant(tenantId: string, tenantName: string): Promise<Tenant> {
  let tenant = await db.tenants.findById(tenantId);
  if (!tenant) {
    tenant = await db.tenants.insert({
      id: tenantId,
      name: tenantName,
      provisionedVia: 'jit',
      createdAt: new Date(),
    });
    await setupMinimalData(tenant);
  }
  return tenant;
}
```

### Scoping queries by tenant

Always scope database queries by tenant to ensure data isolation. **Never trust the client to provide the tenant ID** — always read it from the authenticated user's token (`req.bridgeUser.tenantId`), never from the request body or query string:

```typescript
router.post('/items', async (req, res) => {
  const user = req.bridgeUser!;
  // tenantId comes from the verified JWT, not from the request body
  const item = await items.create(req.body, user.tenantId, user.id);
  res.status(201).json(item);
});

router.get('/items/:id', async (req, res) => {
  const user = req.bridgeUser!;
  // Scoped to the user's tenant — can't reach another tenant's data
  const item = await items.findOne(req.params.id, user.tenantId);
  if (!item) {
    res.status(404).json({ error: 'Not Found', message: 'Item not found' });
    return;
  }
  res.json(item);
});
```
