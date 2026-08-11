# Bridge Express — Authentication & Access Control

You are wiring **backend authentication and access control** into an Express application that uses The Bridge. This is the server-side analog of the frontend "SDK auth" guide: there is no login screen and no token issuance here. The frontend obtains the user's access token; this plugin **verifies** that token on every request, attaches the verified identity to the Express `req`, and gates handlers by privilege, role, and auth type.

All JWT and API-token verification is delegated to `@nebulr-group/bridge-auth-core`. The plugin does no local `jose` verification — for user JWTs it fetches the JWKS, verifies the signature (PS256), checks issuer/audience, and transforms the claims into `BridgeUser` / `BridgeTenant`. API tokens are signed with the per-app HS256 secret (which this app never holds), so they are verified by POSTing them to the Bridge introspection endpoint rather than locally.

## Prerequisites

Verify Bridge is set up in this project:

1. `@nebulr-group/bridge-express` is in `package.json` dependencies.
2. `createBridge(config)` is called once at startup and the instance is reused.
3. `BRIDGE_APP_ID` is set in the environment.

If any are missing, run the integration guide (`integration-prompt.md`) first.

## Two token types

| Type | Header | Verified against | Attached to request | Typical use |
|---|---|---|---|---|
| User JWT | `Authorization: Bearer <jwt>` | `${apiBaseUrl}/auth/.well-known/jwks.json` | `req.bridgeUser`, `req.bridgeTenant`, `req.bridgeAccessToken` | Browser users via a frontend plugin |
| API token | `x-api-key: <jwt>` | `${apiBaseUrl}/account/api-token/introspect` (introspection) | `req.bridgeApiToken` | Server-to-server, programmatic access |

The guard inspects **both** headers. When an API token is present it is verified and its claims land on `req.bridgeApiToken`. When a Bearer token is present it follows the user-JWT path and populates `req.bridgeUser`. The two paths are **independent**: when both headers are present and valid, both contexts coexist on `req`. By default a route accepts **either**.

> **Instant revocation.** API-token introspection is cached for `introspectionCacheTtlMs` (default `0` — every request introspects, so a revoked token stops working immediately). Raise the TTL to trade revocation latency for fewer network calls.

## Step 1 — Choose how the guard runs

**Declarative guard (recommended).** Mount `bridge.auth()` at the app or router level and it runs on every request flowing through it, reading `guard.defaultAccess` and `guard.rules`. Mark exceptions with `bridge.public()` or `privilege: 'ANONYMOUS'` rules.

```ts
const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID!,
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
});

app.use(bridge.auth());
```

**Per-route guard.** If you prefer not to run a declarative guard, apply `bridge.protect()` to the individual routes that need protection. `protect()` always enforces auth (it does not consult `defaultAccess` or config rules — its options *are* the rule):

```ts
import { Request, Response } from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

app.get('/items', bridge.protect(), (req: Request, res: Response) => {
  res.json({ user: req.bridgeUser!.email });
});
```

The examples below assume one of these is active (declarative `bridge.auth()` or per-route `bridge.protect()`).

## Step 2 — Read the authenticated user

After the guard runs, the verified identity is on `req`: `req.bridgeUser` (the `BridgeUser`), `req.bridgeTenant` (the `BridgeTenant`), and `req.bridgeAccessToken` (the raw JWT, handy for forwarding). These are the express analogue of `@CurrentUser()` / `@CurrentTenant()`. The package augments Express's `Request` type, so the fields are typed once you import from `@nebulr-group/bridge-express`.

```ts
import { Request, Response } from 'express';

app.get('/users/me', (req: Request, res: Response) => {
  const user = req.bridgeUser!;
  const tenant = req.bridgeTenant!;
  res.json({
    id: user.id,
    email: user.email,
    role: user.role,
    privileges: user.privileges,
    tenant: { id: tenant.id, name: tenant.name },
  });
});
```

`BridgeUser`: `id`, `email`, `emailVerified`, `username`, `fullName`, `givenName?`, `familyName?`, `locale?`, `onboarded?`, `tenantId`, `appId?`, `scope?`, `role?`, `multiTenantAccess?`, `privileges?`.

`BridgeTenant`: `id`, `name`, `locale?`, `logo?`, `onboarded?`.

**Always scope queries to the verified `tenantId`.** A user's token is only ever valid for their current tenant; never accept a tenant ID from the request body and trust it.

## Step 3 — Gate by role

`bridge.protect({ role })` restricts a route to a role. It applies to **user-JWT callers** only.

```ts
app.get('/admin/dashboard', bridge.protect({ role: 'ADMIN' }), (req, res) => {
  res.json({ dashboard: true });
});

app.get('/admin/settings', bridge.protect({ role: 'OWNER' }), (req, res) => {
  res.json({ settings: true });
});
```

Roles are option-only — there is no `role` field on route rules. A mismatch returns 403.

## Step 4 — Gate API tokens by privilege

`bridge.protect({ privilege })` enforces that the **API token** carries that privilege in its `privileges` claim. User JWTs **bypass** this check for backward compatibility, so an endpoint can require `USER_WRITE` for API-token callers while still serving browser users.

```ts
app.get('/users', bridge.protect({ privilege: 'USER_READ' }), (req, res) => {
  res.json({ users: [] });
});

app.post('/users', bridge.protect({ privilege: 'USER_WRITE' }), (req, res) => {
  res.json({ created: true });
});
```

`ApiTokenClaims` (exported from `@nebulr-group/bridge-express`, re-exported from auth-core):

```ts
interface ApiTokenClaims {
  active: boolean;
  sub: string;               // token subject
  appId: string;             // app the token was issued for
  tenantId: string | null;   // null for app-level tokens
  type: string;
  privileges: string[];
  exp: number;
}
```

> A user JWT, by contrast, is gated by the **route-rule** `privilege` (a non-`ANONYMOUS`/`AUTHENTICATED` privilege on a matched `bridge.auth()` rule must appear in the user's `privileges` claim). The `privilege` *option* on `protect()` targets API tokens; the rule `privilege` targets user JWTs.

## Step 5 — Restrict the accepted auth type

`bridge.protect({ acceptAuth: 'jwt' | 'api_token' | 'both' })` controls which credential a route accepts. Omitting it is equivalent to `'both'`.

```ts
import { Request, Response } from 'express';

// User-only — an API-token-only caller (x-api-key without a Bearer) gets 401.
app.get('/account/profile', bridge.protect({ acceptAuth: 'jwt' }), (req: Request, res: Response) => {
  res.json({ email: req.bridgeUser!.email, role: req.bridgeUser!.role });
});

// API-token-only — a user Bearer token gets 401.
app.post(
  '/integrations/sync',
  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
  (req: Request, res: Response) => {
    const { tenantId } = req.bridgeApiToken!;
    res.json(syncService.run(tenantId));
  },
);
```

**Dual-auth handler** (default — branch on `req.bridgeApiToken`):

```ts
app.get('/users', bridge.protect({ privilege: 'USER_READ' }), (req: Request, res: Response) => {
  if (req.bridgeApiToken) {
    // server-to-server: tenant comes from the API token
    return res.json(usersService.findByTenant(req.bridgeApiToken.tenantId!));
  }
  // browser user: tenant comes from the JWT
  return res.json(usersService.findByTenant(req.bridgeUser!.tenantId));
});
```

## Step 6 — Mark public exceptions

`bridge.public()` overrides any rule and skips authentication for a route — useful for a public `GET` beside a protected `POST` on the same path:

```ts
app.get('/health', bridge.public(), (_req, res) => {
  res.json({ status: 'ok' });
});
```

Prefer the centralized `rules` config (`privilege: 'ANONYMOUS'`) for whole paths, and reserve `bridge.public()` for per-route exceptions. (`public()` sets a flag that the `bridge.auth()` middleware reads to skip the guard, so it only matters when `bridge.auth()` is mounted ahead of the route.)

## Verifying a token manually (advanced)

For non-guard contexts — a custom WebSocket auth hook, a queue consumer — verify directly with `JwksService`. Wrap calls in a `TokenVerificationError` check.

```ts
import { JwksService, TokenVerificationError, BridgeConfigService } from '@nebulr-group/bridge-express';

const jwks = new JwksService(new BridgeConfigService({ appId: process.env.BRIDGE_APP_ID! }));

async function authenticate(bearer: string) {
  try {
    return await jwks.verifyToken(bearer);   // user JWT
  } catch (e) {
    if (e instanceof TokenVerificationError) {
      throw new Error('Invalid token');
    }
    throw e;
  }
}

async function authenticateApiToken(apiKey: string) {
  // expectedAppId guards against tokens minted for a different app
  return jwks.verifyApiToken(apiKey, process.env.BRIDGE_APP_ID!);
}
```

`TokenVerificationError` is the **same class** the guard uses — `instanceof` checks behave identically regardless of which path raised it.

## Error responses

The middleware writes the HTTP response itself (you don't throw and catch): a missing/invalid/expired credential gets `401` with an RFC 6750 `WWW-Authenticate` header; a failed privilege/role/feature-flag check gets `403`. Your handlers only run once the guard has passed, so they can read `req.bridge*` without re-checking.

## Access-control checklist

- [ ] `createBridge(config)` called once at startup; `bridge.auth()` mounted (or `bridge.protect()` on protected routes)
- [ ] `defaultAccess: 'protected'` so unmatched routes require a token
- [ ] Public routes declared with `privilege: 'ANONYMOUS'` rules (or `bridge.public()` per-route)
- [ ] Handlers read identity via `req.bridgeUser` / `req.bridgeTenant`, never trust a tenant ID from the body
- [ ] Role-gated routes use `bridge.protect({ role })` (option-only, user JWT)
- [ ] API-token privilege enforcement via `bridge.protect({ privilege })` where server-to-server access applies
- [ ] `bridge.protect({ acceptAuth })` set on routes that must reject one credential type
- [ ] Manual verification (if any) goes through `JwksService` + `TokenVerificationError`

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **No token → 401:** a protected route without a credential returns 401 with a `WWW-Authenticate` header.
3. **Valid JWT → 200:** a protected route with a valid `Authorization: Bearer` returns 200 scoped to the JWT's tenant.
4. **Role gate:** a `bridge.protect({ role: 'OWNER' })` route returns 403 for a non-owner JWT.
5. **Privilege gate:** a `bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' })` route returns 200 for an API token carrying `TENANT_WRITE`, 401 for a user Bearer token, and 403 for an API token missing the privilege.
6. **Auth-type restriction:** a `bridge.protect({ acceptAuth: 'jwt' })` route returns 401 when called with only `x-api-key`.
