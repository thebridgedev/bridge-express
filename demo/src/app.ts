import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

const bridge = createBridge({
  appId: process.env.BRIDGE_APP_ID || 'demo-app-id',
  authBaseUrl: process.env.BRIDGE_AUTH_BASE_URL,
  backendlessBaseUrl: process.env.BRIDGE_BACKENDLESS_BASE_URL,
  debug: process.env.BRIDGE_DEBUG === 'true',
  guard: {
    defaultAccess: 'protected',
    rules: [
      // Public routes
      { path: '/health', public: true },
      { path: '/api/public/*', public: true },

      // Role-based routes
      { path: '/admin/*', role: 'ADMIN' },

      // Feature flag routes
      { path: '/beta/*', featureFlag: 'beta-access' },
      { path: '/premium/*', featureFlag: { all: ['premium-tier', 'active-subscription'] } },
    ],
  },
});

// Apply global auth middleware
app.use(bridge.auth());

// Health check — public via config rule
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Force public via middleware (overrides auth for this route)
app.get('/api/public/info', bridge.public(), (_req, res) => {
  res.json({ info: 'This is a public endpoint' });
});

// Protected — auth required, any authenticated user
app.get('/items', (req, res) => {
  res.json({
    items: ['item-1', 'item-2'],
    user: req.bridgeUser,
  });
});

// Role-protected via config rule
app.get('/admin/users', (req, res) => {
  res.json({
    users: [],
    requestedBy: req.bridgeUser,
  });
});

// Explicitly protect with role (per-route override)
app.get('/secure/settings', bridge.protect({ role: 'ADMIN' }), (req, res) => {
  res.json({
    settings: {},
    user: req.bridgeUser,
  });
});

// Feature flag protected via config rule
app.get('/beta/feature', (req, res) => {
  res.json({
    feature: 'beta-data',
    user: req.bridgeUser,
  });
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
  console.log('  GET /health              — public');
  console.log('  GET /api/public/info     — public (bridge.public() middleware)');
  console.log('  GET /items               — protected (any authenticated user)');
  console.log('  GET /admin/users         — ADMIN role required');
  console.log('  GET /secure/settings     — ADMIN role required (protect middleware)');
  console.log('  GET /beta/feature        — beta-access feature flag required');
  console.log('  GET /forward/items       — token forwarding demo');
});

export { app };
