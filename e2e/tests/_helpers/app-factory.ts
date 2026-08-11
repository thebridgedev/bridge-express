/**
 * Builds an in-process Express application for E2E testing.
 *
 * The express analogue of bridge-nestjs's `createTestApp()`. The NestJS factory
 * spins up the demo AppModule via @nestjs/testing; here we construct an
 * equivalent Express app from `createBridge(...)` so tests can make real HTTP
 * calls (via supertest) against the same route topology the demo ships —
 * WITHOUT binding a TCP port.
 *
 * Why not import demo/src/app.ts directly? The demo calls `app.listen()` at
 * module-load time, which would bind a port the moment the file is imported.
 * supertest only needs the Express request handler (a callable), so we rebuild
 * the routes here and never call listen(). The bridge wiring (config rules,
 * middleware, protect/public guards) is identical to the demo.
 *
 * The app is built per-suite — create it in beforeAll() (no teardown needed;
 * nothing is listening, so there are no ports/connections to close).
 *
 * IMPORTANT: pass an EnvironmentConfig so the bridge boots against the test
 * app (appId + apiBaseUrl), not production defaults.
 *
 * @example
 * ```typescript
 * import { createTestApp } from './_helpers/app-factory';
 * import supertest from 'supertest';
 * import { getEnvironmentConfig } from '../../config/environments';
 *
 * let request: supertest.Agent;
 *
 * beforeAll(() => {
 *   const app = createTestApp(getEnvironmentConfig());
 *   request = supertest(app);
 * });
 * ```
 */

import express, { Express } from 'express';
import { createBridge } from '@nebulr-group/bridge-express';
import { EnvironmentConfig } from '../../config/environments';

/**
 * Construct a fresh Express test application wired with Bridge auth.
 *
 * Mirrors demo/src/app.ts route topology and guard config, minus the
 * `app.listen()` call. Returns the Express handler for supertest.
 */
export function createTestApp(config: EnvironmentConfig): Express {
  const app = express();
  app.use(express.json());

  const bridge = createBridge({
    appId: config.appId,
    apiBaseUrl: config.testDataApiUrl,
    debug: process.env.BRIDGE_DEBUG === 'true',
    guard: {
      defaultAccess: 'protected',
      rules: [
        // Public routes (no credential required)
        { path: '/health', privilege: 'ANONYMOUS' },
        { path: '/api/public/*', privilege: 'ANONYMOUS' },

        // Any authenticated user JWT
        { path: '/items', privilege: 'AUTHENTICATED' },

        // Privilege-gated for user JWTs (the user's `privileges` claim must include it)
        { path: '/reports/*', privilege: 'TENANT_READ' },
      ],
    },
  });

  // Apply global auth middleware — enforces the config rules above.
  app.use(bridge.auth());

  // Health check — public via config rule
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Force public via middleware (overrides auth for this route)
  app.get('/api/public/info', bridge.public(), (_req, res) => {
    res.json({ info: 'This is a public endpoint' });
  });

  // Protected — auth required, any authenticated user (config: AUTHENTICATED)
  app.get('/items', (req, res) => {
    res.json({
      items: ['item-1', 'item-2'],
      user: req.bridgeUser,
      tenant: req.bridgeTenant,
    });
  });

  // Privilege-gated for user JWTs via config rule (TENANT_READ)
  app.get('/reports/summary', (req, res) => {
    res.json({
      report: 'summary',
      user: req.bridgeUser,
    });
  });

  // Role-protected per-route (the @RequireRole analogue — user JWT only)
  app.get('/admin/users', bridge.protect({ role: 'ADMIN' }), (req, res) => {
    res.json({
      users: [],
      requestedBy: req.bridgeUser,
    });
  });

  // Feature-flag protected per-route (the @RequireFeatureFlag analogue — user JWT only)
  app.get('/beta/feature', bridge.protect({ featureFlag: 'beta-access' }), (req, res) => {
    res.json({
      feature: 'beta-data',
      user: req.bridgeUser,
    });
  });

  // M2M endpoint — accepts a Bridge API token (x-api-key) only, requiring a
  // specific privilege. User JWTs are rejected here (@AcceptAuth('api_token')).
  app.post(
    '/integrations/sync',
    bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
    (req, res) => {
      res.json({
        synced: true,
        appId: req.bridgeApiToken?.appId,
        privileges: req.bridgeApiToken?.privileges,
      });
    },
  );

  return app;
}
