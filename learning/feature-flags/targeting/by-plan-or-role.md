# Target by plan or role

This is one of the biggest advantages of building flags on Bridge instead of
in isolation: if a request is authenticated, Bridge already knows who's signed
in, what role they have, and what their workspace (called a *tenant* in the
API) is paying for, all from the verified JWT the flag is evaluated against.
You don't invent your own "who is this user" plumbing for targeting; it's
already in the token, for every flag, with **no app code**.

Practically, that means an admin can open Control Center (your admin dashboard
at app.thebridge.dev) and write a rule like "on for `user.role = ADMIN`" or
"on for `tenant.plan = ENTERPRISE`" for any flag, the moment you add
`bridge.protect({ featureFlag })` to the route. Nothing to send from your
code, nothing to redeploy.

## What's available automatically

Because evaluation is keyed on the user's access token, the claims in that
token are what a rule targets:

| Attribute | Source | Example values |
|---|---|---|
| `user.role` | the JWT `role` claim | `MEMBER`, `ADMIN`, `OWNER` (or your own custom roles) |
| `user.email` | the JWT | `jane@acme.com` |
| `tenant.id` | the JWT | the current workspace's ID |
| `tenant.plan` | the workspace's subscription | `FREE`, `PRO`, `ENTERPRISE` |
| `privileges` | the JWT `privileges` claim | the signed-in user's privilege list |

These come from the credential the backend already verified; they can't be
forged by the caller, which is exactly why they're safe to gate on.

## Example: gate a feature by role

Turn a flag on only for admins. No attribute-sending code is needed, since
`user.role` is already in the token:

```typescript
router.get('/reports/beta', bridge.protect({ featureFlag: 'beta_reports' }), (req, res) => {
  res.json({ report: buildBetaReport(req.bridgeUser!.tenantId) });
});
```

The admin builds the rule once in Control Center: *on for users matching
`user.role equals ADMIN`*. The route is real server-side enforcement: a caller
who doesn't match gets `403` before the handler runs.

## Example: gate a feature by plan

Same pattern for plan-gating a premium endpoint:

```typescript
router.get('/exports', bridge.protect({ featureFlag: 'export_reports' }), handler);
```

Rule: *on for users matching `bridge:billing.entitlement.export_reports eq true`*,
after listing `export_reports` on the plans that sell it. Prefer the plan
feature over a raw plan name (`tenant.plan equals ENTERPRISE`); it survives
plan renames and custom per-workspace grants, and a workspace without it gets
`402 FEATURE_NOT_IN_PLAN` pointing at your upgrade page. See
[Lock features to a plan](/billing/limits/lock-features/) for that pattern.

## Role vs privilege

Prefer a **privilege** rule (`privileges contains "BETA_REPORTS"`): it scales
when several roles need the same access (grant them the privilege instead of
duplicating the flag rule per role). Write a **role** rule
(`user.role eq "ADMIN"`) only when you mean the role itself. Notably, the backend
sees the full `privileges` array from the JWT, which a frontend session
snapshot doesn't expose. See
[Gate features by role or privilege](/auth/roles/gate-with-flags/) for
role/privilege targeting specifically.

## Every gate is a flag

A flag is the only way to gate a route on role, privilege or plan. Route rules
carry the same flag centrally
(`{ path: '/premium/*', privilege: 'AUTHENTICATED', featureFlag: 'premium' }`);
the removed `plans` / `entitlement` rule fields and `bridge.protect({ role })`
stop the app at startup, naming the flag to use instead. Numbers (how many a
plan allows) are plan limits, not flags: see
[Plan limits](../../plan-limits/plan-limits.md) and
[Route guards](/auth/securing/route-guards/).
