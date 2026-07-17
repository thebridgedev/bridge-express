# Server-side evaluation

In a browser SDK, a flag evaluates locally and instantly against context the
app holds in memory. Bridge Express is the other side of that story: **this is
the backend**, and here a flag is evaluated **server-side, over the Bridge
API, against the caller's verified token**. This page is about what that means
for correctness: when the browser and the backend both make a decision, and
how to keep them from disagreeing.

## How the backend evaluates

When a request carries a user JWT, the middleware (or a `FeatureFlagService`
you call yourself) POSTs that token to the cloud-views flag endpoint
(`{apiBaseUrl}/cloud-views`) and Bridge returns whether the flag is enabled
for that user. The rules (role targeting, plan targeting, rollout) are applied
inside Bridge, keyed on the identity in the token. The backend never holds the
rules and never has to be told who the user is; the token *is* the identity.

The result is cached in-memory per token for 5 minutes, so a guarded route
doesn't re-hit the network on every request from the same user. Evaluation
**fails closed**: an unreachable Bridge resolves to not-enabled, so an outage
never opens a gated route.

## The backend is the authority

A frontend can hide a button behind a flag, but hiding UI is not enforcement;
anyone can call your API directly. When an action must actually be gated, gate
it **here**, on the route, where the token is verified:

```typescript
router.post('/exports/bulk', bridge.protect({ featureFlag: 'bulk_exports' }), handler);
```

This returns `403` for any caller the flag rule doesn't include, regardless of
what a frontend shows or hides. Treat the frontend flag as a UX affordance and
the backend flag as the security boundary.

## Trust the token, not the request body

Because evaluation is keyed on the **verified** JWT, the identity a flag rule
targets (the user's role, workspace, and plan; the API calls the workspace a
*tenant*) comes from a source the caller can't forge. That's the whole point:
don't let a client hand you a role or a plan and target on that.

Concretely, the Express flag API sends **only the access token** to Bridge for
evaluation. There is no mechanism to attach arbitrary attributes or a
client-supplied identity to a backend evaluation, and that's by design. If a
targeting decision depends on a fact only your backend knows (not something in
the token), evaluate the flag as a plain gate and apply that extra condition
in your own handler logic, against your own verified data. See
[Use flags in your logic](/feature-flags/using/in-logic/) and
[Send context from your code](/feature-flags/targeting/send-context/).

## Agreeing with the frontend

If a Bridge frontend already evaluated the same flag for the same signed-in
user, the backend will reach the same answer on its own: both sides key on the
same identity (the frontend's session, the backend's verified JWT), and the
rule lives in one place in Bridge. You don't forward the frontend's decision
or its context to the backend; you re-evaluate against the token the frontend
is already sending as its `Authorization` header. Same user, same rule, same
result.

The one thing that can differ is *timing*: the frontend evaluates live over
the live channel (a persistent realtime connection the frontend SDK
maintains), while the backend reads a per-token cache that refreshes every few
minutes. For a decision that must be exact to the second, pass `forceLive`
when you evaluate in a handler (see
[Use flags in your logic](/feature-flags/using/in-logic/)).
