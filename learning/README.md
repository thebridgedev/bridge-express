# Bridge Express Documentation

Documentation for The Bridge Express plugin: authentication, flag-based access control, plan limits, API token support, feature flags, and multi-tenancy for Express apps.

## Quick Links

- [Quickstart Guide](./quickstart/quickstart.md): install, configure, and protect routes in minutes
- [Examples](./examples/examples.md): comprehensive examples for all features
- [Authentication & Access Control](./auth/auth.md)
- [Configuration](./configuration/configuration.md)
- [Feature Flags](./feature-flags/feature-flags.md)
- [Plan Limits](./plan-limits/plan-limits.md): `bridge.requireQuota` / `bridge.syncQuota`, counter vs gauge, the `402` the frontend reads
- [Tenant Data with `bridge.fromRequest()`](./bridge-service/bridge-service.md): subscription, entitlements, usage, branding for the current request
- [Multi-Tenancy](./multi-tenancy/multi-tenancy.md)
- [Frontend Integration](./frontend-integration/frontend-integration.md)
- [Error Handling](./error-handling/error-handling.md)

## Features

- Built on `@nebulr-group/bridge-auth-core`, with JWT/API-token verification delegated to the shared core
- A single `createBridge(config?)` factory (settings from `BRIDGE_APP_ID` / `BRIDGE_API_BASE_URL` / `BRIDGE_DEBUG` when omitted): no decorators, no modules, no dependency injection; you get one `bridge` instance (the object returned by `createBridge`) with middleware factories and an HTTP client
- JWT authentication with JWKS verification
- API token authentication (`x-api-key` header) verified via Bridge token introspection, with privilege enforcement
- Declarative route protection via a `guard` config: route rules say `ANONYMOUS` or `AUTHENTICATED`, plus the flag that decides who gets the route
- Per-route protection via `bridge.protect(options)`: feature flag, API-token privilege, and accepted-auth-type overrides. Every gate on a person is a flag
- Plan limits: `bridge.requireQuota(metric, { current? })` / `bridge.syncQuota(metric, { current })` refuse with a structured `402` at the limit and record usage after a 2xx
- Tenant data: `bridge.fromRequest(req)` reads subscription, entitlements, usage, branding, and user for the verified user's workspace
- Token forwarding between services via `bridge.http`
- Multi-tenancy support with tenant/user extraction onto the Express `Request`
- RFC 6750-compliant error responses

## The factory model in one paragraph

Express has no module system or dependency injection, so Bridge Express is configured once at startup and exposes everything through a single instance:

```typescript
import { createBridge } from '@nebulr-group/bridge-express';

const bridge = createBridge(); // BRIDGE_APP_ID / BRIDGE_API_BASE_URL from the environment

app.use(bridge.auth());                                              // declarative guard (reads config rules)
router.get('/admin', bridge.protect({ featureFlag: 'admin-panel' })); // per-route flag
router.post('/tickets', bridge.requireQuota('tickets', { current }));  // plan limit
router.get('/open', bridge.public());                                // force a route public
const tenant = bridge.fromRequest(req);                              // unified tenant surface
await bridge.http.get(url, req.bridgeAccessToken);                   // token-forwarding HTTP client
```

`bridge.auth()`, `bridge.protect()`, `bridge.public()`, `bridge.requireQuota()`, `bridge.syncQuota()` and `bridge.requireEntitlement()` all return standard Express `RequestHandler` middleware. After a request authenticates, the verified context is attached to the Express `Request`: `req.bridgeUser`, `req.bridgeTenant`, `req.bridgeAccessToken` (user JWT path) and `req.bridgeApiToken` (API token path).

## Coming from another framework?

If you know the Bridge NestJS plugin, the decorator-to-middleware mapping is:

| NestJS | Express |
|---|---|
| `BridgeModule.forRoot(config)` | `createBridge(config)` |
| dependency injection of `BridgeService` / `BridgeHttpService` | the returned `bridge` instance |
| `APP_GUARD` (global guard) | `app.use(bridge.auth())` |
| `@Public()` | `bridge.public()` |
| `@RequirePrivilege('USER_READ')` (API tokens only) | `bridge.protect({ privilege: 'USER_READ' })` (API tokens only) |
| `@RequireFeatureFlag('beta')` | `bridge.protect({ featureFlag: 'beta' })` |
| `@AcceptAuth('api_token')` | `bridge.protect({ acceptAuth: 'api_token' })` |
| `@RequireQuota('tickets', { current })` | `bridge.requireQuota('tickets', { current })` |
| `@SyncQuota('tickets', { current })` | `bridge.syncQuota('tickets', { current })` |
| `@RequireEntitlement('pdf')` | `bridge.requireEntitlement('pdf')` |
| `BridgeQuotaService` | `bridge.quota` |
| `bridge.fromRequest(req)` | `bridge.fromRequest(req)` (same) |
| `@CurrentUser()` / `@CurrentTenant()` | `req.bridgeUser` / `req.bridgeTenant` |
| `bridge.fromJwt(jwt)` | `bridge.fromJwt(jwt)` (same) |
