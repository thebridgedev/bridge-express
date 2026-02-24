import { RequestHandler } from 'express';
import { BridgeConfig } from './types/config';
import { BridgeConfigService } from './services/bridge-config.service';
import { JwksService } from './services/jwks.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { BridgeHttpService } from './services/bridge-http.service';
import {
  createAuthMiddleware,
  createProtectMiddleware,
  createPublicMiddleware,
  BridgeMiddlewareOptions,
} from './middleware/auth.middleware';

export type { BridgeMiddlewareOptions };

export interface BridgeExpressInstance {
  /** Reads config rules + defaultAccess — use as router/app-level middleware */
  auth(): RequestHandler;
  /** Enforce auth with optional local overrides — use per-route */
  protect(options?: BridgeMiddlewareOptions): RequestHandler;
  /** Skip auth — use per-route for public endpoints */
  public(): RequestHandler;
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
 *     rules: [{ path: '/health', public: true }],
 *   },
 * });
 *
 * app.use(bridge.auth());
 * router.get('/health', bridge.public(), handler);
 * router.get('/admin', bridge.protect({ role: 'ADMIN' }), handler);
 * ```
 */
export function createBridge(config: BridgeConfig): BridgeExpressInstance {
  const configService = new BridgeConfigService(config);
  const jwksService = new JwksService(configService);
  const featureFlagService = new FeatureFlagService(configService);
  const httpService = new BridgeHttpService();

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

    http: httpService,
  };
}
