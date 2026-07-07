---
title: Request authentication states
description: Every outcome a request can land in once bridge.auth() / bridge.protect() runs, and what's on req afterward.
sidebar:
  label: Express
---

# Request authentication states

A frontend Bridge SDK tracks a single reactive `authState` that walks a signed-in user through a multi-step login flow (credentials, MFA, tenant selection, fully authenticated). An Express backend doesn't have a login flow to walk through — it evaluates one request at a time, independently, with no memory of the previous one. The useful equivalent here is the set of outcomes `bridge.auth()` / `bridge.protect(...)` can land a request in.

## The outcomes

| Outcome | HTTP result | What's on `req` afterward |
|---|---|---|
| No credential offered | `401` — `WWW-Authenticate: ... error="missing_token"` | Nothing; handler never runs |
| Malformed `Authorization` header | `401` — `error="invalid_token"` | Nothing; handler never runs |
| Expired user JWT | `401` — `error="expired_token"` | Nothing; handler never runs |
| Invalid signature / unknown key / bad issuer or audience | `401` — `error="invalid_token"` | Nothing; handler never runs |
| API token issued for a different app | `401` — `error="invalid_token"` | Nothing; handler never runs |
| Wrong credential type for this endpoint (`acceptAuth`) | `401` — `error="invalid_request"` | Nothing; handler never runs |
| Valid user JWT, but missing required `role` / route-rule `privilege` / `featureFlag` | `403 Forbidden` | `req.bridgeUser` is set even though the handler never runs |
| Valid API token, but missing required `privilege` | `403 Forbidden` | `req.bridgeApiToken` is set even though the handler never runs |
| Valid user JWT only | handler runs | `req.bridgeUser`, `req.bridgeTenant`, `req.bridgeAccessToken` set; `req.bridgeApiToken` unset |
| Valid API token only | handler runs | `req.bridgeApiToken` set; `req.bridgeUser`/`req.bridgeTenant`/`req.bridgeAccessToken` unset |
| Both a valid user JWT **and** a valid API token | handler runs | All four are set — both contexts coexist on `req` |
| Route marked public (`bridge.public()` or an `ANONYMOUS` route rule) | handler runs, no verification attempted | Nothing set; `req.bridgeUser`/`req.bridgeApiToken` are `undefined` |

The two credential paths are evaluated **independently** — when both an `x-api-key` and an `Authorization: Bearer` header are present and valid, both contexts coexist on the request rather than one taking precedence (some Bridge frontends always send both). See [API tokens](/auth/api-tokens/) for the full dual-credential story, and [Configuration](/auth/config/) for the exact JSON error bodies.

## Checking which state you're in, inside a handler

For a dual-auth endpoint (the default), branch on which context is present:

```typescript
router.get('/users', bridge.protect({ privilege: 'USER_READ' }), (req, res) => {
  if (req.bridgeApiToken) {
    // Authenticated via API token (machine caller)
    return res.json({ users: [], tenantId: req.bridgeApiToken.tenantId });
  }

  // Authenticated via user JWT (a signed-in person)
  const user = req.bridgeUser!;
  return res.json({ users: [], tenantId: user.tenantId });
});
```

## Why there's no "in-progress" state

A frontend's `authState` has intermediate states (`'credentials-validated'`, `'mfa-required'`, `'tenant-selection'`) because signing in is a multi-step, stateful process that the SDK walks a browser through. Verifying a request has no equivalent multi-step process — a token either verifies against Bridge's JWKS (or introspection endpoint) right now, in full, or it doesn't. There's nothing partial to represent. The MFA challenge, tenant selection, and credential exchange that produced the token already happened upstream, in whichever frontend or CLI flow signed the user in — by the time a request reaches your Express app, that's all settled into a single bearer token you either accept or reject.
