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

Enforcing this set from Express: every gate is a flag. Put a flag on the route and rule the flag on a privilege, so any role carrying it qualifies (the `privilege` *option* on `bridge.protect(...)` applies to API-token callers only, so it's not the tool for gating signed-in people):

```typescript
// Flag `manage-settings`, rule: privileges contains "USER_WRITE" (Admin, not Member or Viewer)
router.get('/settings', bridge.protect({ featureFlag: 'manage-settings' }), handler);

// Or centrally, as a route rule. Flag `reports`, rule: privileges contains "TENANT_READ"
// (Member and Admin above, but not Viewer) can reach /reports/*.
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' }],
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

The privilege alone doesn't turn the feature on for your API; put a flag on the route and rule it on the privilege, so any future role that carries `BETA_REPORTS` also qualifies (see [Gate features by role or privilege](/auth/roles/gate-with-flags/)):

```typescript
// Flag `beta_reports`, rule: privileges contains "BETA_REPORTS"
router.get('/reports/beta', bridge.protect({ featureFlag: 'beta_reports' }), handler);
```
