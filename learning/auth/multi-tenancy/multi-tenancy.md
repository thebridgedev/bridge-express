---
title: Multi-tenancy
description: Reading and enforcing tenant isolation server-side in an Express app.
sidebar:
  label: Express
---

# Multi-tenancy

Bridge has first-class multi-tenant architecture: a user can belong to more than one workspace (called a *tenant* in the API; these docs use *workspace* in prose and keep `tenant` in identifiers). The same credentials let a user sign in to every workspace they belong to, but everything workspace-scoped is configured *separately* per workspace: role, plan, entitlements, quotas, and branding can all differ. The same person can be `ADMIN` in one workspace and `OWNER` in another, signing in with the exact same email and password either way.

Every authenticated request carries exactly one workspace context: the verified workspace is on `req.bridgeUser.tenantId` and `req.bridgeTenant` (see [Getting the user token](/auth/user-token/getting-the-token/)). `req.bridgeUser.role` always reflects that person's role in whichever workspace issued the current token; a request from the same user acting in a different workspace carries a different token, with a different role.

## Where the active workspace comes from

Picking *which* workspace a session is for is a frontend/sign-in-flow concern, not something your Express app decides. By the time a request reaches your backend, that choice has already been made and baked into the token. The trigger for that choice, for context: a user is only prompted to pick between workspaces when they have more than one **enabled** membership in an **active** workspace. A disabled membership, or a workspace that isn't active (suspended for non-payment, for example), doesn't count, even though the underlying tenant-user record still exists. Your Express app never needs to re-derive this; it only ever sees the one workspace the already-completed sign-in flow selected, on `req.bridgeUser.tenantId`.

## Isolation is enforced server-side, and that's you

This is the part your Express app is directly responsible for. Tenant isolation isn't a client-side property; it's whatever your route handlers actually do with `req.bridgeUser.tenantId`.

**Never trust the client to provide the tenant ID.** Always read it from the authenticated user's token, never from the request body or query string:

```typescript
router.post('/items', bridge.protect(), async (req, res) => {
  const user = req.bridgeUser!;
  // tenantId comes from the verified JWT, not from the request body
  const item = await items.create(req.body, user.tenantId, user.id);
  res.status(201).json(item);
});

router.get('/items/:id', bridge.protect(), async (req, res) => {
  const user = req.bridgeUser!;
  // Scoped to the user's tenant: can't reach another tenant's data
  const item = await items.findOne(req.params.id, user.tenantId);
  if (!item) {
    res.status(404).json({ error: 'Not Found', message: 'Item not found' });
    return;
  }
  res.json(item);
});
```

For API-token callers, the equivalent field is `req.bridgeApiToken.tenantId`, which is `null` for app-level tokens not bound to a single workspace (see [API tokens](/auth/api-tokens/)).

### Data separation strategies

**1. Column-based separation (recommended for most cases)**

Add a `tenantId` column to your tables and filter every query by it:

```typescript
// Pseudocode model: use your ORM/driver of choice (Prisma, Knex, TypeORM, raw SQL).
interface Item {
  id: string;
  tenantId: string;   // every row belongs to exactly one tenant
  name: string;
  createdBy: string;
}
```

**2. Schema-based separation**: separate database schema per workspace (more isolation, more complexity).

**3. Database-based separation**: completely separate databases per workspace (maximum isolation, highest complexity).

## Just-in-Time (JIT) provisioning

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

Call it from a small middleware using the verified tenant ID from the token:

```typescript
router.use(async (req, _res, next) => {
  const user = req.bridgeUser;
  if (user) {
    await ensureTenant(user.tenantId, req.bridgeTenant?.name ?? '');
  }
  next();
});
```

## Webhook-based provisioning

Bridge sends webhooks when workspaces and users are created:

- `TENANT_CREATED`: new workspace/account created
- `TENANT_UPDATED`: workspace details changed
- `TENANT_USER_CREATED`: new user added to a workspace
- `TENANT_USER_UPDATED`: user details changed
- `TENANT_USER_DELETED`: user removed from a workspace

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

> **Verify the webhook signature.** A public route is reachable by anyone. Validate the `x-webhook-signature` header against your Bridge webhook secret before acting on the payload.

## Recommended pattern: webhooks + JIT fallback

The most robust approach combines both methods: webhooks as the primary provisioning path, JIT as a fallback if a request beats the webhook:

```typescript
// Called from the webhook: primary provisioning path
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

// Called on each request: JIT fallback
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

## Workspace-scoped data beyond the JWT

For subscription plan, entitlements, and branding (none of which are in the JWT), use `bridge.fromJwt(req.bridgeAccessToken!)` rather than hand-rolling REST calls. See [Tenant Data](../../bridge-service/bridge-service.md) for the full reference and [How the token is kept current](/auth/user-token/object-updates/) for its caching behavior.
