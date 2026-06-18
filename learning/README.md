# Bridge Express Documentation

Documentation for The Bridge Express plugin — authentication, privilege-based access control, API token support, feature flags, and multi-tenancy for Express applications.

## Quick Links

- [Quickstart Guide](./quickstart/quickstart.md) — Install, configure, and protect routes in minutes
- [Examples](./examples/examples.md) — Comprehensive examples for all features
- [Authentication & Access Control](./auth/auth.md)
- [Configuration](./configuration/configuration.md)
- [Feature Flags](./feature-flags/feature-flags.md)
- [Tenant Data — `bridge.fromJwt()`](./bridge-service/bridge-service.md) — subscription, entitlements, branding for the current request
- [Multi-Tenancy](./multi-tenancy/multi-tenancy.md)
- [Frontend Integration](./frontend-integration/frontend-integration.md)
- [Error Handling](./error-handling/error-handling.md)

## Features

- Built on `@nebulr-group/bridge-auth-core` — JWT/API-token verification delegated to the shared core
- A single `createBridge(config)` factory — no decorators, no modules, no dependency injection; you get one `bridge` instance with middleware factories and an HTTP client
- JWT authentication with JWKS verification
- API token authentication (`x-api-key` header) verified via Bridge token introspection, with privilege enforcement
- Declarative route protection via a `guard` config — privilege-based route rules (`ANONYMOUS`, `AUTHENTICATED`, `USER_READ`, etc.)
- Per-route protection via `bridge.protect(options)` — role, privilege, feature-flag, and accepted-auth-type overrides
- Tenant data — `bridge.fromJwt(jwt)` reads subscription, entitlements, branding, and user for the current request
- Plan-gated routes (subscription-based access)
- Token forwarding between services via `bridge.http`
- Multi-tenancy support with tenant/user extraction onto the Express `Request`
- RFC 6750-compliant error responses

## The factory model in one paragraph

Express has no module system or dependency injection, so Bridge Express is configured once at startup and exposes everything through a single instance:

```typescript
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge({ appId: process.env.BRIDGE_APP_ID! });

app.use(bridge.auth());                                  // declarative guard (reads config rules)
router.get('/admin', bridge.protect({ role: 'ADMIN' })); // per-route override
router.get('/open', bridge.public());                    // force a route public
const tenant = bridge.fromJwt(req.bridgeAccessToken!);   // unified tenant surface
await bridge.http.get(url, req.bridgeAccessToken);       // token-forwarding HTTP client
```

`bridge.auth()`, `bridge.protect()`, and `bridge.public()` all return standard Express `RequestHandler` middleware. After a request authenticates, the verified context is attached to the Express `Request`: `req.bridgeUser`, `req.bridgeTenant`, `req.bridgeAccessToken` (user JWT path) and `req.bridgeApiToken` (API token path).

## Coming from another framework?

If you know the Bridge NestJS plugin, the decorator-to-middleware mapping is:

| NestJS | Express |
|---|---|
| `BridgeModule.forRoot(config)` | `createBridge(config)` |
| dependency injection of `BridgeService` / `BridgeHttpService` | the returned `bridge` instance |
| `APP_GUARD` (global guard) | `app.use(bridge.auth())` |
| `@Public()` | `bridge.public()` |
| `@RequireRole('ADMIN')` | `bridge.protect({ role: 'ADMIN' })` |
| `@RequirePrivilege('USER_READ')` | `bridge.protect({ privilege: 'USER_READ' })` |
| `@RequireFeatureFlag('beta')` | `bridge.protect({ featureFlag: 'beta' })` |
| `@AcceptAuth('api_token')` | `bridge.protect({ acceptAuth: 'api_token' })` |
| `@CurrentUser()` / `@CurrentTenant()` | `req.bridgeUser` / `req.bridgeTenant` |
| `bridge.fromJwt(jwt)` | `bridge.fromJwt(jwt)` (same) |
