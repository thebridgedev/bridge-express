# Changelog — @nebulr-group/bridge-express

## Unreleased (0.7.0)

### Added — plan limits as middleware (TBP-745)

The express twin of bridge-nestjs 0.8.0 `@RequireQuota` / `@SyncQuota` / `@RequireEntitlement`: the same REST calls, the same refusal bodies, the same workspace-scoped hashed idempotency key (TBP-738).

- `bridge.requireQuota(metric, { current? })` refuses with `402 QUOTA_EXCEEDED` (`{ statusCode, code, message, metric, used, limit, fix }`) at the plan's limit and records usage only after a 2xx. Counter mode (no `current`) reports one event keyed by the request's `Idempotency-Key`; gauge mode (`current`) compares your count and sets the gauge. A `metered` quota never refuses; a quota that cannot be read answers `503` (fail-closed).
- `bridge.syncQuota(metric, { current })` sets a gauge to your count after a 2xx, for deletes and bulk operations.
- `bridge.requireEntitlement(key)` refuses with `403 ENTITLEMENT_REQUIRED` (`{ statusCode, code, message, entitlement, fix }`). The documented exception to "every gate is a flag"; outside production it logs a one-time note.
- `bridge.quota` (`BridgeQuotaService`): `check`, `assertQuota`, `record`, `sync`, `assertEntitlement` as plain calls. Refusals are thrown as `BridgeRefusalError` (`QuotaExceededError`, `EntitlementRequiredError`) with `status` and `body`.
- `bridge.fromRequest(req)`: the tenant view for the user the auth middleware verified on the request. Only a token `bridge.auth()` / `bridge.protect()` verified counts — never a header or `req.bridgeAccessToken`.
- `tenant.usage`: `quota(metric)`, `report(metric, n, key)`, `set(metric, count)`.
- Outside production, a counting response carries `X-Bridge-Usage-Counted: <metric>` so bridge-svelte can warn when the page counts the same metric too.
- `createBridge()` with no arguments boots from `BRIDGE_APP_ID`, `BRIDGE_API_BASE_URL` and `BRIDGE_DEBUG`. Explicit options win over the environment, including `debug: false`.

### BREAKING — every gate is a flag

Mirrors bridge-nestjs 0.8.0 (TBP-705). A person is gated by a flag whose rule says why; an app no longer compares a role, a privilege list, a plan or an entitlement itself. Each removed option now fails **at startup** with a message naming the flag setup to use — never silently ignored, which would open the route.

| Removed | Use instead |
|---|---|
| `bridge.protect({ role: 'ADMIN' })` | `bridge.protect({ featureFlag: 'admin-panel' })`, flag rule `privileges contains "USER_WRITE"` (or whatever decides it) |
| `bridge.protect({ plans: ['pro'] })` and route-rule `plans` | `featureFlag: '<feature>'`, flag rule `bridge:billing.entitlement.<feature> eq true`, feature listed on the plans that sell it (`bridge plan feature add pro <feature>`) |
| `bridge.protect({ entitlement \| entitlements })` and route-rule `entitlement` / `entitlements` | `featureFlag: '<key>'`, flag rule `bridge:billing.entitlement.<key> eq true` (a flag that is off for a plan reason answers `402 FEATURE_NOT_IN_PLAN`) — or `bridge.requireEntitlement('<key>')` if you explicitly want no flag |
| Route-rule `privilege: 'USER_READ'` (any value other than `'ANONYMOUS'` / `'AUTHENTICATED'`) | `privilege: 'AUTHENTICATED', featureFlag: '<flag>'`, flag rule `privileges contains "USER_READ"`. For API-token callers: `bridge.protect({ privilege: 'USER_READ' })` (API tokens only, unchanged) |

Also gone: the `402 { error: 'Payment required', reason: 'plan_required' \| 'entitlement_missing' \| 'billing_locked' }` body those options answered with. A frontend reading it should read `code` (`FEATURE_NOT_IN_PLAN`, `QUOTA_EXCEEDED`) instead, which is what the Bridge frontend plugins already do.

`RoutePrivilege` is now `'ANONYMOUS' | 'AUTHENTICATED'`, and `BridgeMiddlewareOptions` has `privilege`, `acceptAuth` and `featureFlag` only. Run `npx @nebulr-group/bridge-cli check gates` to list every direct check left in the app.
