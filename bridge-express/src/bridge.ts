import { RequestHandler } from 'express';
import { BridgePullCache } from '@nebulr-group/bridge-auth-core';
import { BridgeConfig } from './types/config';
import { BridgeConfigService } from './services/bridge-config.service';
import { JwksService } from './services/jwks.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { BridgeHttpService } from './services/bridge-http.service';
import { BridgeService } from './bridge/bridge.service';
import { TenantScope } from './bridge/tenant-scope';
import {
  createAuthMiddleware,
  createProtectMiddleware,
  createPublicMiddleware,
  BridgeMiddlewareOptions,
  AuthType,
} from './middleware/auth.middleware';
import { BridgeQuotaService } from './quota/quota.service';
import {
  createRequireEntitlementMiddleware,
  createRequireQuotaMiddleware,
  createSyncQuotaMiddleware,
  type RequireQuotaOptions,
  type SyncQuotaOptions,
} from './quota/quota.middleware';

export type { BridgeMiddlewareOptions, AuthType };

// Unified backend surface (TBP-341) — re-exported so index.ts can surface the
// service/scope and snapshot types from the package root.
export { BridgeService } from './bridge/bridge.service';
export { TenantScope } from './bridge/tenant-scope';
export type {
  BrandingSnapshot,
  SubscriptionSnapshot,
  UserSnapshot,
  SessionSnapshotData,
  TenantEntitlementsView,
  TenantUsageView,
  QuotaSnapshot,
} from './bridge/tenant-scope';

export interface BridgeExpressInstance {
  /** Reads config rules + defaultAccess — use as router/app-level middleware */
  auth(): RequestHandler;
  /** Enforce auth with optional local overrides — use per-route */
  protect(options?: BridgeMiddlewareOptions): RequestHandler;
  /** Skip auth — use per-route for public endpoints */
  public(): RequestHandler;
  /**
   * Unified backend surface (TBP-341): returns a tenant-scoped view
   * (subscription, entitlements, branding, user) for the tenant the user JWT
   * belongs to. The snapshot is cached per request via BridgePullCache.
   */
  fromJwt(userJwt: string): TenantScope;
  /**
   * TBP-745 — the TenantScope for the user `auth()` / `protect()` verified on
   * this request. Throws when no user token was verified on it.
   */
  fromRequest(req: unknown): TenantScope;
  /**
   * TBP-745 — refuse with 402 `QUOTA_EXCEEDED` at the plan's limit for
   * `metric`, and record usage once the handler answered 2xx.
   *
   * - Counter (no `current`): compares Bridge's count; reports 1 event after a
   *   2xx, keyed by the `Idempotency-Key` header when the request sends one.
   * - Gauge (`current`): compares your count; sets the gauge after a 2xx.
   *
   * A `metered` quota never refuses. Nothing is recorded for a refused or
   * failed (4xx/5xx) request. Put it after `auth()` / `protect()`.
   *
   * @example
   * router.post('/tickets', bridge.requireQuota('tickets', { current: (t) => tickets.countFor(t.id) }), create);
   * router.post('/export', bridge.protect({ featureFlag: 'exports-enabled' }), bridge.requireQuota('exports'), exportIt);
   */
  requireQuota(metric: string, options?: RequireQuotaOptions): RequestHandler;
  /**
   * TBP-745 — keep a gauge in step without checking the limit: after a 2xx,
   * set `metric` to your current count. For deletes and bulk operations.
   */
  syncQuota(metric: string, options: SyncQuotaOptions): RequestHandler;
  /**
   * TBP-745 — refuse with 403 `ENTITLEMENT_REQUIRED` unless the tenant's plan
   * includes `key`. Exception, not the standard (TBP-705): the standard is
   * `protect({ featureFlag: '<key>' })` with the flag ruled on
   * `bridge:billing.entitlement.<key> eq true`. Outside production it logs a
   * one-time note.
   */
  requireEntitlement(key: string): RequestHandler;
  /** TBP-745 — the plain calls behind the three middleware above. */
  quota: BridgeQuotaService;
  /** HTTP client for token-forwarding requests */
  http: BridgeHttpService;
}

/**
 * Create a Bridge Express instance.
 *
 * @param config - Bridge configuration. `appId`, `apiBaseUrl` and `debug` fall
 *   back to `BRIDGE_APP_ID`, `BRIDGE_API_BASE_URL` and `BRIDGE_DEBUG`, so
 *   `createBridge()` with no arguments boots from the environment.
 * @returns BridgeExpressInstance with middleware factories and HTTP client
 *
 * @example
 * ```typescript
 * const bridge = createBridge({
 *   guard: {
 *     defaultAccess: 'protected',
 *     rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
 *   },
 * });
 *
 * app.use(bridge.auth());
 * router.get('/health', bridge.public(), handler);
 * router.get('/admin', bridge.protect({ featureFlag: 'admin-panel' }), handler);
 * // M2M endpoint — API token with a required privilege:
 * router.post('/sync', bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }), handler);
 * ```
 */
export function createBridge(config: BridgeConfig = {}): BridgeExpressInstance {
  const configService = new BridgeConfigService(config);
  const jwksService = new JwksService(configService);
  const featureFlagService = new FeatureFlagService(configService);
  const httpService = new BridgeHttpService();
  const pullCache = new BridgePullCache();
  const bridgeService = new BridgeService(
    configService.apiBaseUrl,
    configService.appId,
    pullCache,
  );
  const quotaService = new BridgeQuotaService(bridgeService, configService);

  return {
    auth(): RequestHandler {
      return createAuthMiddleware(configService, jwksService, featureFlagService, bridgeService);
    },

    protect(options?: BridgeMiddlewareOptions): RequestHandler {
      return createProtectMiddleware(
        configService,
        jwksService,
        featureFlagService,
        bridgeService,
        options,
      );
    },

    public(): RequestHandler {
      return createPublicMiddleware();
    },

    fromJwt(userJwt: string): TenantScope {
      return bridgeService.fromJwt(userJwt);
    },

    fromRequest(req: unknown): TenantScope {
      return bridgeService.fromRequest(req);
    },

    requireQuota(metric: string, options?: RequireQuotaOptions): RequestHandler {
      return createRequireQuotaMiddleware(quotaService, metric, options);
    },

    syncQuota(metric: string, options: SyncQuotaOptions): RequestHandler {
      return createSyncQuotaMiddleware(quotaService, metric, options);
    },

    requireEntitlement(key: string): RequestHandler {
      return createRequireEntitlementMiddleware(quotaService, key);
    },

    quota: quotaService,

    http: httpService,
  };
}
