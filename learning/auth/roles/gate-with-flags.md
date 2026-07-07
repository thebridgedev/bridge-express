---
title: Gate features by role or privilege
description: Role and privilege as feature-flag targeting attributes, decoded from the JWT the middleware already verified.
sidebar:
  label: Express
---

# Gate features by role or privilege

Role and privilege are both available as feature-flag targeting attributes automatically, decoded from the JWT — no wiring, no context you have to pass by hand. For flag mechanics in general, see [Feature Flags](../feature-flags/feature-flags.md).

| Attribute | Value | Example |
|-----------|-------|---------|
| `user.role` | the role key | `"ENTERPRISE_BETA"` |
| `privileges` | array of privilege keys | `["USER_READ", "BETA_REPORTS"]` |

## Continuing the enterprise example

Following on from [Common role setups](/auth/roles/common-setups/) — a flag `beta_reports` with a rule targeting the role directly:

```
user.role eq "ENTERPRISE_BETA"
```

or targeting the privilege instead:

```
privileges contains "BETA_REPORTS"
```

Targeting the role is simpler when the role only ever means one thing. Targeting the privilege scales better if several different roles might eventually need the same access — grant them the privilege instead of duplicating the flag rule per role.

## Enforcing it in Express

`bridge.protect({ featureFlag })` evaluates the flag against the requesting user's access token — the same token whose `role`/`privileges` claims the flag rule above targets:

```typescript
router.get('/reports/beta', bridge.protect({ featureFlag: 'beta_reports' }), (req, res) => {
  res.json({ report: buildBetaReport(req.bridgeUser!.tenantId) });
});
```

This is real server-side enforcement, not just hiding a button — a request that doesn't satisfy the flag rule gets a `403 Forbidden` before your handler runs, regardless of what a caller's frontend shows or hides. Flag evaluation applies to the user-JWT path only; it's not evaluated for API-token callers (see [How roles & privileges work](/auth/roles/how-it-works/) for which checks apply to which credential type).
