---
title: Logging in and logging out
description: Why bridge-express has no login/logout of its own, and what it does instead — verifying a token on every request.
sidebar:
  label: Express
---

# Logging in and logging out

`@nebulr-group/bridge-express` doesn't have a login or logout flow, and it isn't meant to — signing in happens in a frontend Bridge SDK (or the CLI, or directly against `bridge-api`), which is what actually calls the authentication endpoints and ends up holding a JWT. Your Express app is a **resource server**: it never issues tokens, never stores a session, and never needs to know whether "login" or "logout" happened. All it does is verify whatever token shows up on the next request.

That reframes the interesting question for a backend package: not "how does a user log in," but "what makes a request trustworthy," on every single call. That's `bridge.auth()` / `bridge.protect(...)` and the underlying `JwksService`.

## What happens on every request

1. **The middleware runs on every matching request**, whether mounted globally (`app.use(bridge.auth())`) or per-route (`bridge.protect(...)`) — see [Route guards](/auth/securing/route-guards/). There's no server-side session or "already authenticated" flag it can shortcut past. Each request re-verifies its own bearer token from scratch.
2. **User-JWT verification is signature + issuer + audience + expiry**, checked against Bridge's JWKS endpoint — `JwksService.verifyToken()` confirms the token was signed by a known Bridge key, issued by `{apiBaseUrl}/auth`, and scoped to your `appId`.
3. **The JWKS keyset itself is cached, not fetched per request** — one hour TTL by default, refreshed lazily the first time it's needed after expiry.
4. **API tokens are verified differently: by introspection, not locally.** They're signed with a per-app secret this package never holds, so `verifyApiToken` POSTs the token to Bridge's introspection endpoint instead of checking a signature locally. This has a side effect user-JWT verification doesn't: **instant revocation is possible**, because the Bridge re-checks the backing record on every uncached call (`introspectionCacheTtlMs` defaults to `0` — always fresh).
5. **User JWTs carry no revocation list.** JWKS verification only checks the four things in step 2 — it does not ask "has this specific token been revoked." A user access token remains acceptable for as long as it's unexpired and correctly signed, full stop.

That last point is the practical answer to "logging out" for the user-JWT path: from `bridge-express`'s point of view, logout is a non-event. There's no server-side session for a logout to invalidate, because there was never a server-side session to begin with — a frontend `logout()` call just erases the token from `localStorage` on the client. If the same (still-unexpired) access token were replayed against your API after that, the middleware would still accept it; it has no way to know the frontend "logged out." This is exactly why Bridge's frontend SDKs proactively refresh short-lived access tokens rather than relying on long-lived ones, and why revocable, hash-at-rest API tokens exist as a separate mechanism for the cases that need immediate invalidation — see [API tokens](/auth/api-tokens/).

## Failure modes you'll actually see

Since there's no "log back in" step on this side either, every rejection is really "this token, right now, doesn't verify" — surfaced as RFC 6750-style errors so a client can react appropriately instead of just seeing a bare `401`:

| Cause | `WWW-Authenticate` `error` | Typical client reaction |
|---|---|---|
| No `Authorization` or `x-api-key` header sent | `missing_token` | Redirect to login |
| Token's `exp` has passed | `expired_token` | Silently refresh, then retry |
| Malformed token, or (API-token path) wrong `type` claim | `invalid_token` | Redirect to login |
| Signed by a key not in the current JWKS | `invalid_token` | Redirect to login — often a stale local JWKS/environment mismatch |
| Issuer/audience mismatch | `invalid_token` | Redirect to login |
| (API-token path only) token's `appId` doesn't match this app | `invalid_token` | Redirect to login |

A well-behaved client distinguishes `expired_token` (silently refresh, then retry) from everything else (send the user back through the actual login flow, which lives entirely outside this package).

## If you're building your own admin endpoints

If your Express app proxies to Bridge's own management API for things like role changes, that's still not "login" — it's your backend forwarding an already-verified caller's token (`req.bridgeAccessToken`) to Bridge. See [The owner role](/auth/roles/owner-role/) for a worked example of that pattern.
