---
title: Feature Flags
order: 40
oneLiner: Gate a route or branch server-side logic on a flag, flip it live from Control Center, no redeploy.
related: [auth, payments]
---

# Feature Flags

Bridge Feature Flags lets you ship code dark, roll it out to a segment, target
it at specific users, and kill it instantly, all without a deploy. In Bridge
Express the switch is enforced **on the server, during the request**:
`bridge.protect({ featureFlag })` evaluates the flag over the Bridge API
against the requesting user's access token and returns `403 Forbidden` before
your handler runs when it isn't enabled. Results are cached per token, so
repeated checks from the same user within the cache window don't re-hit the
network.

Flags build on auth: evaluation is keyed on the verified user JWT, so it
applies to the user-JWT path only (not API-token callers), and everything
Bridge already knows about the caller is available to target on with no app
code.

## The mental model

1. **You create a flag in Control Center** (your admin dashboard at
   app.thebridge.dev) and give it rules: on/off, a rollout, or conditions on
   attributes like `user.role` or `tenant.plan`.
2. **Bridge evaluates those rules server-side** against the identity in the
   caller's verified access token. Nothing to send from your code; the token
   *is* the identity.
3. **Changes apply without a deploy.** Edit a rule in Control Center and it
   governs the next evaluation. No restart, no redeploy; within the per-token
   cache window a caller may briefly see the previous answer.

For the full picture (evaluation model, per-token caching, outage behavior),
read [How flags work](/feature-flags/how-it-works/).

## Get started

[Get started](/feature-flags/get-started/) walks the whole loop in a few
minutes: create the `bridge` instance, create a flag in Control Center, gate a
route with `bridge.protect({ featureFlag })`, then flip it and watch the route
open up.

## Using flags

- [Use flags in your logic](/feature-flags/using/in-logic/): the
  `FeatureFlagService` API for branching handler code paths instead of gating
  the whole route, plus limits an admin can tune.
- [Guard routes](/feature-flags/using/guard-routes/): gate a single route or a
  whole router with `bridge.protect({ featureFlag })`, and combine flags with
  `any` / `all` requirement objects.
- [Server-side evaluation](/feature-flags/using/backend/): how the backend
  evaluates, how it agrees with a Bridge frontend, and what to trust.

## Targeting

- [Target by plan or role](/feature-flags/targeting/by-plan-or-role/):
  attributes like `user.role` and `tenant.plan` come from the verified token
  with no app code. For plan-granted features, prefer entitlement attributes;
  see [Lock features to a plan](/billing/limits/lock-features/).
- [Send context from your code](/feature-flags/targeting/send-context/): what
  the backend supplies automatically, and why it deliberately doesn't forward
  client-supplied attributes.

> **Framework note:** Flags on this path are **boolean**: the middleware gates
> on enabled / not-enabled. For multi-type variant values (string, number,
> JSON), roll them out on a Bridge frontend SDK where flags evaluate
> client-side.
