---
title: API tokens
description: Verifying Bridge API tokens on incoming requests, and what the token actually is.
sidebar:
  label: Express
---

# API tokens

Bridge lets your users create API tokens for programmatic access to your API — the same idea as a GitHub or Stripe personal access token — without you having to build token issuance, storage, or revocation yourself. Typical callers: CI/CD pipelines, cron jobs, personal automation scripts, and third-party integrations that need to call your API without a real login session.

An Express backend is on the *verifying* side of this: a caller sends the token, and `bridge-express` checks it on every request.

## How it works

- **Sent via `x-api-key`** — as a JWT, alongside or instead of `Authorization: Bearer <userJwt>`.
- **Verified by introspection, not locally** — API tokens are signed with a per-app HS256 secret this package never holds, so `bridge-express` POSTs the token to Bridge's introspection endpoint (`{apiBaseUrl}/account/api-token/introspect`) rather than checking a signature itself. The Bridge collapses every rejection (forged, tampered, revoked, expired) into `{ active: false }` — no information leak about *why* a token was rejected.
- **Privilege-scoped** — a token is created with an explicit set of privileges (the same privilege keys your [roles](/auth/roles/how-it-works/) use). It can never do more than what it was granted, and the middleware enforces that server-side (see below).
- **Workspace-scoped** — a token is bound to the tenant it was created in (`tenantId: null` for an app-level token not bound to any single tenant) and can't be replayed against another one.
- **Hash-at-rest, shown once** — Bridge stores only a salted hash of the token. Nothing about long-term storage or display is your app's concern.
- **Revocation is immediate** — because verification is a live introspection call rather than a local signature check, a revoked token gets a `401` on its very next request, no cache to wait out (unless you've opted into `introspectionCacheTtlMs` — see [Configuration](/auth/config/)).

On success, the claims are attached to `req.bridgeApiToken`:

```typescript
interface ApiTokenClaims {
  sub: string;               // Token subject identifier
  appId: string;              // App ID the token was issued for
  tenantId: string | null;    // Tenant ID (null for app-level tokens)
  type: 'api';                 // Always 'api' for API tokens
  privileges: string[];       // Privilege strings (e.g. ['USER_READ', 'TENANT_WRITE'])
  exp?: number;                // Expiry (epoch seconds)
}
```

## Requiring a privilege

Pass `privilege` to `bridge.protect(...)` to require that an API token carries a specific privilege. **User JWTs bypass this option entirely** — it only applies to the API-token path, so adding a `privilege` requirement to an endpoint doesn't break existing user-JWT access:

```typescript
// API tokens must carry USER_READ; user JWTs are unaffected.
router.get('/users', bridge.protect({ privilege: 'USER_READ' }), handler);

// API tokens must carry USER_WRITE.
router.post('/users', bridge.protect({ privilege: 'USER_WRITE' }), handler);
```

## Restricting which credential types an endpoint accepts

`acceptAuth` restricts which credential types an endpoint accepts — the type is `'jwt' | 'api_token' | 'both'` (default `'both'`):

```typescript
// Only user JWTs accepted — an API token alone gets 401
bridge.protect({ acceptAuth: 'jwt' })

// Only API tokens accepted — a user JWT alone gets 401
bridge.protect({ acceptAuth: 'api_token' })

// Both accepted (default when omitted)
bridge.protect({ acceptAuth: 'both' })
```

> When `acceptAuth: 'jwt'` and **both** headers are present (some Bridge frontends always send both), the request is accepted and the JWT path populates `req.bridgeUser`; the API key is treated as informational only. The endpoint is rejected only if the API token is the *only* credential offered.

## Dual-auth endpoints

Endpoints that accept both user JWTs and API tokens (the default) branch on which context is present:

```typescript
router.get('/users', bridge.protect({ privilege: 'USER_READ' }), (req, res) => {
  if (req.bridgeApiToken) {
    // Authenticated via API token
    return res.json({ users: [], tenantId: req.bridgeApiToken.tenantId });
  }

  // Authenticated via user JWT
  const user = req.bridgeUser!;
  return res.json({ users: [], tenantId: user.tenantId });
});
```

Both credentials can be present and valid on the same request — `req.bridgeApiToken` and `req.bridgeUser` coexist rather than one overriding the other. See [Request authentication states](/auth/user-token/auth-states/) for the full outcome table.

## API-token-only endpoints

For machine-to-machine traffic only:

```typescript
router.post(
  '/integrations/sync',
  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
  (req, res) => {
    const { tenantId, privileges } = req.bridgeApiToken!;
    res.json({ synced: true, tenantId });
  },
);
```

## Using a token to call another Bridge-aware service

If your Express app itself needs to call a *downstream* service on behalf of the caller (rather than just verifying an inbound token), forward the raw credential with `bridge.http` — see [Getting the user token](/auth/user-token/getting-the-token/#the-raw-access-token-reqbridgeaccesstoken) for the equivalent on the user-JWT path.

## Letting your users manage their own tokens

Issuing, listing, and revoking API tokens is a management-plane concern, not something `bridge-express` exposes an API for — that flow lives in a frontend Bridge SDK's drop-in token-management component, or the CLI/Control Center. Your Express app only ever sees the *result*: a token on `x-api-key` that it verifies on each request.
