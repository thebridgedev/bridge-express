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

Rule: *on for users matching `tenant.plan equals ENTERPRISE`*. If you're
gating something billing already grants access to, prefer targeting an
entitlement over a raw plan name; it survives plan renames and custom
per-workspace grants. See
[Lock features to a plan](/billing/limits/lock-features/) for that pattern.

## Role vs privilege

Targeting the **role** is simplest when the role only ever means one thing.
Targeting a **privilege** (`privileges contains "BETA_REPORTS"`) scales better
when several roles might eventually need the same access: grant them the
privilege instead of duplicating the flag rule per role. Notably, the backend
sees the full `privileges` array from the JWT, which a frontend session
snapshot doesn't expose. See
[Gate features by role or privilege](/auth/roles/gate-with-flags/) for
role/privilege targeting specifically.

## Plans on route rules: a different mechanism

Bridge Express route rules also declare a `plans` restriction
(`{ path: '/premium/*', privilege: 'AUTHENTICATED', plans: ['PREMIUM', 'ENTERPRISE'] }`):
privilege-gating with a plan filter, configured centrally, and independent of
feature flags. Use a flag when you want the switch to be flippable from
Control Center without touching config; use a route-rule `plans` restriction
for a static plan boundary baked into the guard. See
[Route guards](/auth/securing/route-guards/).
