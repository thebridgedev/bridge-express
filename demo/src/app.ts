import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID || 'demo-app-id',
  apiBaseUrl: process.env.BRIDGE_API_BASE_URL,
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

// Unified backend surface (TBP-341) — entitlement check for the caller's tenant.
app.get('/features/export', async (req, res) => {
  const tenant = bridge.fromJwt(req.bridgeAccessToken!);
  if (!(await tenant.entitlements.can('export'))) {
    res.status(403).json({ error: 'Forbidden', message: "Entitlement 'export' required" });
    return;
  }
  res.json({ subscription: await tenant.subscription });
});

// Token forwarding — calls /items internally with forwarded token
app.get('/forward/items', async (req, res) => {
  const port = (req.socket as any).localPort || process.env.PORT || 3000;
  const data = await bridge.http.get(
    `http://localhost:${port}/items`,
    req.bridgeAccessToken,
  );
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bridge Express demo running on http://localhost:${PORT}`);
  console.log('');
  console.log('Routes:');
  console.log('  GET  /health              — public (ANONYMOUS)');
  console.log('  GET  /api/public/info     — public (bridge.public() middleware)');
  console.log('  GET  /items               — protected (any authenticated user)');
  console.log('  GET  /reports/summary     — user JWT with TENANT_READ privilege');
  console.log('  GET  /admin/users         — ADMIN role required (protect middleware)');
  console.log('  GET  /beta/feature        — beta-access feature flag required');
  console.log('  POST /integrations/sync   — API token (x-api-key) with TENANT_WRITE');
  console.log('  GET  /features/export     — entitlement check via bridge.fromJwt()');
  console.log('  GET  /forward/items       — token forwarding demo');
});

export { app };
