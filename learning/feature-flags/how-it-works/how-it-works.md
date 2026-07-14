# How flags work

A feature flag is a switch on a piece of behavior in your app that you control
from Control Center instead of from a deploy. Wrap something in a flag and you
can:

- **Ship dark** — merge and deploy an endpoint while it's still off for
  everyone, then turn it on when it's ready.
- **Roll out gradually** — turn it on for a segment, watch, then widen it.
- **Target a segment** — turn it on only for a role, a plan, or an internal
  cohort, matched against the identity in the caller's token.
- **Kill it instantly** — something's wrong in production? Flip it off. No
  rollback, no redeploy.

Every one of those is an action you take in Control Center. You never touch the
deployed backend to change who a flag is on for.

## The evaluation model

Unlike a browser SDK that keeps flag rules in memory and evaluates them locally,
Bridge Express evaluates a flag **server-side, over the Bridge API, during the
request**. The middleware POSTs the requesting user's access token to the
cloud-views flag endpoint (`{apiBaseUrl}/cloud-views`) and gets back whether the
flag is enabled for that user. The rules — including any role/plan targeting —
live in Bridge and are applied there, so the backend never has to know them.

- **Keyed on the user JWT.** A flag is evaluated against the requesting user's
  access token, so the answer already reflects who they are and what their
  tenant is. Flag gating applies to the **user-JWT path only** — it isn't
  evaluated for API-token callers.
- **Cached per token.** The result of an evaluation is cached in-memory keyed by
  the token, for a few minutes. A route guarded by `bridge.protect({ featureFlag })`
  doesn't re-hit the network on every request from the same user within that
  window — the first request warms the cache (bulk-evaluating the user's flags),
  subsequent ones read from it.
- **Boolean.** Server-side evaluation returns enabled / not-enabled. The gate is
  a boolean decision; there are no string/number/JSON variant values on this
  path.

## It fails closed

If the Bridge API is unreachable or returns an error, an evaluation resolves to
**not enabled** — a guarded route returns `403`. Flag gating is satisfied only
on a positive result, so an outage never accidentally *opens* a gated route.

The flip side: for a kill-switch-style route where "flag absent" should mean
"allow", don't gate the route with the flag directly. Protect it with a normal
privilege/role rule and check the flag programmatically inside the handler, so
*you* decide the fallback — see [Use flags in your logic](/feature-flags/using/in-logic/).

## Flags build on auth

Because evaluation is keyed on the verified user JWT, everything Bridge auth
already knows about the caller — their role, their tenant, their plan — is
available to target on with **no code on your side**. An admin can write a rule
like "on for `user.role = ADMIN`" against any flag, and the backend enforces it
the moment you add `bridge.protect({ featureFlag })` to the route. See
[Target by plan or role](/feature-flags/targeting/by-plan-or-role/).

Next: [Get started](/feature-flags/get-started/).
