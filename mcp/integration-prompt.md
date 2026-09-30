# Bridge Express Integration

You are integrating The Bridge into an Express application. This adds JWT-based authentication, tenant context, flag-based access control, plan limits, and feature flags to your API.

This is a **backend** integration: there are no UI components, no login screen, and no checkout redirect. The frontend (a Bridge frontend plugin — svelte/react/nextjs/angular) handles login and obtains the user's access token; this plugin verifies that token on every request and exposes the verified identity on the Express `req` object for your route handlers.

There is no module system and no dependency injection here. You create a single Bridge instance with a factory at startup and call methods on it — `bridge.auth()`, `bridge.protect(options?)`, `bridge.public()`, `bridge.requireQuota(metric)`, `bridge.syncQuota(metric)`, `bridge.fromRequest(req)`, `bridge.http`.

## Prerequisites

- **appId** — your Bridge application ID. Get it from `bridge app get` or the Bridge dashboard.
- **Package manager** — use whatever the project already uses (check for `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json`).
- An existing Express app (`express` ^4 or ^5).

## Migration check

Before starting, check if the project has existing auth.

**Migrating from a custom JWT-middleware integration:**

| Old (custom) | New (bridge-express) |
|---|---|
| Custom `jose`/`jsonwebtoken` verification middleware | `bridge.auth()` / `bridge.protect()` (built-in JWKS handling) |
| Hand-rolled `req.user` population | `req.bridgeUser` populated by the middleware |
| Manual tenant extraction from the JWT | `req.bridgeTenant` populated by the middleware |
| Ad-hoc `process.env.APP_ID` | `appId` passed to `createBridge(config)` |

**Migration steps:**
1. Remove the old verification middleware and any custom `req.user` typing.
2. Install bridge-express (see Install section).
3. Create the Bridge instance with `createBridge(config)` at startup.
4. Mount `app.use(bridge.auth())` and replace custom guards with `bridge.protect(...)` / `bridge.public()`.
5. Replace `req.user` reads with `req.bridgeUser` / `req.bridgeTenant`.

**If no existing auth is found:** skip migration steps, proceed directly to Install.

## Install

```bash
npm i @nebulr-group/bridge-express
```

Replace `npm i` with the project's package manager (`bun add`, `pnpm add`, `yarn add`).

`@nebulr-group/bridge-auth-core` is pulled in automatically as a transitive dependency — do **not** install it directly. All JWT and API-token verification is delegated to auth-core; this plugin does no local `jose` verification of its own. User JWTs are verified against the JWKS; API tokens are verified by POSTing them to the Bridge introspection endpoint (the app never holds the per-app HS256 secret, so verification is a network call, not a local check).

Peer dependency (already present in any Express project):
- `express` (^4.0.0 || ^5.0.0)

## Create the Bridge instance

Call `createBridge(config)` **once** at startup and reuse the returned instance everywhere. There is no module to register and nothing global — the instance owns the JWKS cache, the HTTP client, and the unified backend surface.

```ts
import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

// appId comes from BRIDGE_APP_ID (apiBaseUrl / debug from BRIDGE_API_BASE_URL / BRIDGE_DEBUG)
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
  },
});

// Apply the declarative guard at the app (or router) level.
app.use(bridge.auth());
```

**Key points:**
- `bridge.auth()` is the declarative guard. Mounted with `app.use(...)`, it runs on every request that flows through it, reading `guard.defaultAccess` and `guard.rules` from the config.
- `defaultAccess: 'protected'` means any route without a matching `ANONYMOUS` rule requires a valid token.
- The instance verifies user JWTs (PS256) against `${apiBaseUrl}/auth/.well-known/jwks.json` and API tokens via `${apiBaseUrl}/account/api-token/introspect`.
- `apiBaseUrl` defaults to `https://api.thebridge.dev`. Everything derives from it.

**With config from the environment** (the common pattern — no async factory needed, just read `process.env`):

```ts
// Explicit options win over the environment; the environment wins over defaults.
const bridge = createBridge({
  appId: process.env.MY_BRIDGE_APP_ID,                // only if you name the variable differently
  apiBaseUrl: 'https://api.thebridge.dev',            // optional override
  debug: false,                                       // wins over BRIDGE_DEBUG=true
  guard: {
    defaultAccess: 'protected',
  },
});
```

**Docker / private-network note:** if the container can't reach the public `apiBaseUrl`, override the resolution URLs directly: `userJwksUrl` for user-JWT verification and `introspectionUrl` for API-token introspection. Both let verification resolve over your internal network without changing `apiBaseUrl`.

## Mark public endpoints

Declare public routes in the `rules` array using `privilege: 'ANONYMOUS'`. This keeps route protection visible in one place:

```ts
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/cards/*', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
});

app.use(bridge.auth());
```

**RouteRule schema** (`{ path?, graphqlOperation?, privilege, featureFlag? }`):
- `path` — REST URL wildcard pattern. `*` matches a path segment: `/cards/*` matches `/cards/123`, `/cards/search`, etc.
- `graphqlOperation` — reserved for parity with other Bridge plugins. **Per-operation GraphQL guarding is NOT wired in express** (the guard matches on REST path only). Protect a `/graphql` route with `bridge.protect(...)` instead; do not rely on `graphqlOperation` rules.
- `privilege` — `'ANONYMOUS'` or `'AUTHENTICATED'` (see below).
- `featureFlag` — the flag that decides who gets the route; its rule says why.

> **Every gate is a flag.** There are no `public`, `role`, `plans`, `entitlement` or `methods` fields. A rule with any of them, or with a privilege key such as `USER_READ`, stops the app at startup with an error naming the flag to use instead.

**Alternative:** the `bridge.public()` middleware marks an individual route public and overrides any rule. Prefer the centralized `rules` config for consistency, and reach for `bridge.public()` when you need a single handler on an otherwise-protected path (e.g. a public `GET` next to a protected `POST` on the same route):

```ts
app.get('/api/public/info', bridge.public(), (_req, res) => {
  res.json({ info: 'public' });
});
```

Scan the project's routes to decide what should be public (health checks, public read-only content, webhook receivers) and add those to `rules`. Everything else stays protected by default.

## Privilege levels — RoutePrivilege

```ts
type RoutePrivilege =
  | 'ANONYMOUS'      // no authentication required
  | 'AUTHENTICATED'; // any valid token (user JWT or API token)
```

```ts
guard: {
  defaultAccess: 'protected',
  rules: [
    { path: '/health', privilege: 'ANONYMOUS' },
    { path: '/api/status', privilege: 'AUTHENTICATED' },
    // flag rule: privileges contains "USER_READ"
    { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
    // flag rule: bridge:billing.entitlement.premium eq true
    { path: '/premium/*', privilege: 'AUTHENTICATED', featureFlag: 'premium' },
  ],
}
```

Anything finer than "signed in" is a flag. A person the flag's rule leaves out gets `403 FEATURE_NOT_PERMITTED` / `FEATURE_OFF`, or `402 FEATURE_NOT_IN_PLAN` when only an upgrade would turn it on.

## Access user and tenant context

After the guard runs, the verified identity is on the Express request: `req.bridgeUser`, `req.bridgeTenant`, and `req.bridgeAccessToken`. These are the express analogue of `@CurrentUser()` / `@CurrentTenant()`. The `Request` type is augmented by the package, so the fields are typed once you import from `@nebulr-group/bridge-express`.

```ts
import { Request, Response } from 'express';

app.post('/decks', (req: Request, res: Response) => {
  const user = req.bridgeUser!;
  const tenant = req.bridgeTenant!;
  return res.json(decksService.create(req.body, user.id, tenant.id));
});

app.get('/decks', (req: Request, res: Response) => {
  return res.json(decksService.findByUser(req.bridgeUser!.id));
});
```

**`BridgeUser` properties** (built from the verified JWT claims):
- `id` — user ID (from the `sub` claim)
- `email`, `emailVerified`, `username`
- `fullName`, `givenName`, `familyName`, `locale`
- `tenantId` — current tenant/workspace ID
- `appId` — app ID from the token (`aid` claim)
- `role` — user's role in the current tenant (e.g. `'OWNER'`, `'ADMIN'`, `'USER'`); for display, never for gating
- `privileges` — array of privilege strings (e.g. `['AUTHENTICATED', 'USER_READ']`)
- `onboarded`, `multiTenantAccess`, `scope`

**`BridgeTenant` properties:**
- `id`, `name`, `locale`, `logo`, `onboarded`

**Always scope queries to the verified `tenantId`.** A user's token is only ever valid for their current tenant; never accept a tenant ID from the request body and trust it.

## Access control — every gate is a flag

Who may reach a route is a flag: `bridge.protect({ featureFlag })` on the route (or a rule's `featureFlag`). The flag's rule says why — a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.<key> eq true`) or a rollout. App code never reads `role`, `privileges` or the plan to decide access. Read the app's real roles and privileges (`list_roles`) before writing a rule, and prefer a privilege rule over a role rule.

```ts
// Flag `admin-area`, rule: privileges contains "USER_WRITE"
app.get('/admin/dashboard', bridge.protect({ featureFlag: 'admin-area' }), (req, res) => {
  res.json({ dashboard: true, by: req.bridgeUser });
});
```

`protect()` always enforces auth, regardless of `defaultAccess`. `bridge.protect({ role })`, `protect({ plans })` and `protect({ entitlement })` were removed and throw at startup, naming the flag to use. Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` and fix every direct check it lists.

## API tokens and dual auth

The guard accepts two token types: a user JWT via `Authorization: Bearer <token>`, and a server-to-server API token via the `x-api-key` header. When an API token is verified its claims are attached to `req.bridgeApiToken` (`ApiTokenClaims`). Both headers can be present at once — when they are, both contexts coexist on `req`.

- `bridge.protect({ privilege: 'USER_READ' })` — enforce a privilege on **API tokens**. It is a machine's scope, not a gate on a person: a user JWT is not checked against it (people are gated by flags).
- `bridge.protect({ acceptAuth: 'jwt' | 'api_token' | 'both' })` — restrict which token type a route accepts. Default is `'both'`.

```ts
import { Request, Response } from 'express';

// M2M endpoint — API token only, requiring a privilege. A user Bearer token gets 401.
app.post(
  '/integrations/sync',
  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
  (req: Request, res: Response) => {
    const { tenantId } = req.bridgeApiToken!;
    return res.json(syncService.run(tenantId));
  },
);
```

`ApiTokenClaims`: `{ active, sub, appId, tenantId, type, privileges, exp }` — `tenantId` is `null` for app-level tokens.

See **auth-prompt.md** for the full token-verification, flag, privilege, and auth-type story.

## GraphQL

Express has no built-in GraphQL execution context. Mount your GraphQL handler on a route and protect that whole route like any other:

```ts
app.use('/graphql', bridge.protect(), graphqlHandler);
```

Per-operation `graphqlOperation` rules are **reserved and not wired** in express — the guard matches REST paths only. If you need per-operation gating, enforce it inside your resolvers using `req.bridgeUser` / `req.bridgeApiToken`.

## Feature flags

Feature flags gate behavior behind a switch you control from the Bridge dashboard, no redeploy required. Express checks flags **on demand over the Bridge API** with a short in-memory cache — declaratively via `bridge.protect({ featureFlag })` and programmatically via `FeatureFlagService`. See **feature-flags-prompt.md** for setup and both forms in detail.

## Billing and entitlements

A plan limit is one middleware: `bridge.requireQuota(metric, { current? })` refuses with `402 QUOTA_EXCEEDED` at the limit and records usage after a 2xx; `bridge.syncQuota(metric, { current })` keeps a gauge in step after deletes. A plan feature (yes/no) is a flag ruled on `bridge:billing.entitlement.<key> eq true`. Read tenant data (subscription, entitlements, branding) with `bridge.fromRequest(req)`. A backend plugin never runs checkout — purchasing lives in the frontend plugin. See **billing-prompt.md**.

## Environment variables

```env
BRIDGE_APP_ID=your-app-id-here
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRIDGE_APP_ID` | Yes, unless `appId` is passed | — | Your Bridge application ID |
| `BRIDGE_API_BASE_URL` | No | `https://api.thebridge.dev` | Bridge API base URL |
| `BRIDGE_DEBUG` | No | `false` | Enable debug logging |

`createBridge()` reads these itself when the matching option is not passed; an explicit option wins.

## Verify the integration

1. **Build check:** run the project's build command — no TypeScript or import errors.
2. **Start check:** start the dev server — the app boots and `createBridge` runs cleanly.
3. **Public endpoint:** `curl http://localhost:{port}/health` (or a `bridge.public()` route) returns 200.
4. **Protected endpoint, no token:** `curl http://localhost:{port}/decks` returns 401 with a `WWW-Authenticate` header.
5. **Protected endpoint, valid token:** send a request with a valid `Authorization: Bearer <token>` header — returns 200 with data scoped to that user's tenant.
