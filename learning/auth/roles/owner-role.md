---
title: The owner role
description: The rules Bridge enforces around the OWNER role, and what they mean for a role-management endpoint you build.
sidebar:
  label: Express
---

# The owner role

Every tenant has an `OWNER` role, and Bridge enforces some rules around it that you'll want to know before you hit them:

- **Every tenant must have at least one owner.** Whoever creates a tenant becomes its first `OWNER` automatically.
- **You can't demote the last owner.** Changing a user's role away from `OWNER` is blocked if they're the only owner left in the tenant — the API rejects it with "There must be at least one owner for this workspace." Promote someone else to `OWNER` first, then demote the original one.
- **The `OWNER` role itself can't be deleted, and its key can't be changed to something else.** You can still edit its name, description, or (carefully) its privilege set.

`OWNER` is granted the broadest default privilege set (`AUTHENTICATED`, `USER_READ`, `USER_WRITE`, `TENANT_READ`, `TENANT_WRITE`) — treat it as the role for whoever is ultimately accountable for the workspace, not a role you hand out casually. If you gate a route with `bridge.protect({ role: 'OWNER' })`, expect it to match a small set of users per tenant.

## What this means in practice

Role assignment itself is a management-plane call, not something `bridge-express` wraps (see [Assign roles to users](/auth/roles/assign-roles/)) — but if your Express app fronts an admin API that proxies role changes to Bridge on a caller's behalf, forward the caller's verified token rather than re-deriving credentials, and surface the "last owner" rejection as a clear error to your own client instead of a generic 500:

```typescript
router.post('/admin/users/:id/role', bridge.protect({ role: 'OWNER' }), async (req, res) => {
  try {
    await bridge.http.post(
      `${bridgeApiBaseUrl}/team/users/${req.params.id}`,
      { role: req.body.role },
      req.bridgeAccessToken!,
    );
    res.json({ updated: true });
  } catch (err) {
    if (err instanceof BridgeHttpError && err.status === 400) {
      // "There must be at least one owner for this workspace."
      res.status(400).json({ error: 'Bad Request', message: 'Promote another owner first' });
      return;
    }
    throw err;
  }
});
```

`BridgeHttpError` is Bridge Express's error type for non-2xx responses from `bridge.http` — see [Configuration](/auth/config/) and the error-handling reference for its shape.
