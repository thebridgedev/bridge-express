---
title: Common role setups
description: A few role/privilege patterns that cover most apps, and how to enforce each in Express.
sidebar:
  label: Express
---

# Common role setups

A few patterns that cover most apps, built from privileges you define once and reuse across roles. Roles are per workspace (a workspace is called a *tenant* in the API).

## Regular user, admin, and read-only

| Role | Key | Privileges | Use case |
|------|-----|------------|----------|
| Member | `MEMBER` | `AUTHENTICATED`, `USER_READ`, `TENANT_READ` | Everyday user: sees their own data and the workspace, can't manage other users or workspace settings |
| Admin | `ADMIN` | `AUTHENTICATED`, `USER_READ`, `USER_WRITE`, `TENANT_READ` | Can manage team members; workspace-level settings (billing, plan) stay with `OWNER` |
| Viewer | `VIEWER` | `AUTHENTICATED`, `USER_READ` | Read-only: can sign in and look around, can't create or edit anything |

`ADMIN` ships with exactly this privilege set by default. `MEMBER` and `VIEWER` are yours to add:

```bash
bridge role create --name Member --key MEMBER --privileges AUTHENTICATED,USER_READ,TENANT_READ

bridge role create --name Viewer --key VIEWER --privileges AUTHENTICATED,USER_READ
```

Enforcing this set from Express: gate on the role with `bridge.protect({ role })`, or gate on a privilege with a route rule (route-rule privileges are checked against the user JWT's `privileges` claim; note that the `privilege` *option* on `bridge.protect(...)` applies to API-token callers only, so it's not the tool for gating signed-in people):

```typescript
router.get('/settings', bridge.protect({ role: 'ADMIN' }), handler);

// Privilege-gate via a route rule: any role carrying TENANT_READ
// (Member and Admin above, but not Viewer) can reach /reports/*.
const bridge = createBridge({
  appId,
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/reports/*', privilege: 'TENANT_READ' }],
  },
});
```

## A bespoke role for one client

Say an enterprise client is paying for early access to a reporting feature nobody else has. Create a privilege for it in Control Center (your admin dashboard at app.thebridge.dev), `BETA_REPORTS`, then a role that bundles it in with the rest of what that user needs:

```bash
bridge role create --name "Enterprise Beta" --key ENTERPRISE_BETA \
  --privileges AUTHENTICATED,USER_READ,TENANT_READ,BETA_REPORTS
```

Assign it to that client's users:

```bash
bridge user invite --email user@enterprise-client.com --role ENTERPRISE_BETA --tenant-id <theirTenantId>
```

The privilege alone doesn't turn the feature on for your API; gate the route on it directly (or, if the rollout should be toggleable without a redeploy, layer a feature flag on top; see [Gate features by role or privilege](/auth/roles/gate-with-flags/)):

```typescript
// Gate on the role:
router.get('/reports/beta', bridge.protect({ role: 'ENTERPRISE_BETA' }), handler);

// Or gate on the privilege via a route rule, so any future role
// that carries BETA_REPORTS also qualifies:
const bridge = createBridge({
  appId,
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/reports/beta', privilege: 'BETA_REPORTS' }],
  },
});
```
