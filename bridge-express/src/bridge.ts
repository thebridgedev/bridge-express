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
  /** HTTP client for token-forwarding requests */
  http: BridgeHttpService;
}

/**
 * Create a Bridge Express instance.
 *
 * @param config - Bridge configuration
 * @returns BridgeExpressInstance with middleware factories and HTTP client
 *
 * @example
 * ```typescript
 * const bridge = createBridge({
 *   appId: process.env.BRIDGE_APP_ID!,
 *   guard: {
 *     defaultAccess: 'protected',
 *     rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
 *   },
 * });
 *
 * app.use(bridge.auth());
 * router.get('/health', bridge.public(), handler);
 * router.get('/admin', bridge.protect({ role: 'ADMIN' }), handler);
 * // M2M endpoint — API token with a required privilege:
 * router.post('/sync', bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }), handler);
 * ```
 */
export function createBridge(config: BridgeConfig): BridgeExpressInstance {
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

  return {
    auth(): RequestHandler {
      return createAuthMiddleware(configService, jwksService, featureFlagService);
    },

    protect(options?: BridgeMiddlewareOptions): RequestHandler {
      return createProtectMiddleware(configService, jwksService, featureFlagService, options);
    },

    public(): RequestHandler {
      return createPublicMiddleware();
    },

    fromJwt(userJwt: string): TenantScope {
      return bridgeService.fromJwt(userJwt);
    },

    http: httpService,
  };
}
