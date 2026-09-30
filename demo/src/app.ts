import express from 'express';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();
app.use(express.json());

// Settings come from BRIDGE_APP_ID / BRIDGE_API_BASE_URL / BRIDGE_DEBUG when
// none are passed (explicit option > env > default).
const bridge = createBridge({
  guard: {
    defaultAccess: 'protected',
    rules: [
      // Public routes (no credential required)
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/api/public/*', privilege: 'ANONYMOUS' },

      // Any signed-in caller
      { path: '/items', privilege: 'AUTHENTICATED' },

      // Who gets reports is a flag; its rule says why
      // (e.g. `privileges contains "TENANT_READ"`).
      { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
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

// Flag-gated via config rule (featureFlag: 'reports')
app.get('/reports/summary', (req, res) => {
  res.json({
    report: 'summary',
    user: req.bridgeUser,
  });
});

// Admin area — every gate is a flag. Give `admin-panel` the rule
// `privileges contains "USER_WRITE"` (or whatever decides it) in Bridge.
app.get('/admin/users', bridge.protect({ featureFlag: 'admin-panel' }), (req, res) => {
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

// ── Plan limits (TBP-745) ──────────────────────────────────────────────────
// A gauge: tickets exist, so the app counts them. The request is refused with
// 402 QUOTA_EXCEEDED at the limit; after a 2xx the gauge is set to the count.
const tickets = new Map<string, string[]>();
const countFor = (tenantId: string) => (tickets.get(tenantId) ?? []).length;

app.post(
  '/tickets',
  bridge.requireQuota('tickets', { current: (t) => countFor(t.id) }),
  (req, res) => {
    const list = tickets.get(req.bridgeTenant!.id) ?? [];
    list.push(`ticket-${list.length + 1}`);
    tickets.set(req.bridgeTenant!.id, list);
    res.status(201).json({ id: list[list.length - 1] });
  },
);

// Deleting one frees room: after the 2xx the gauge is set to the new count.
app.delete(
  '/tickets/:id',
  bridge.syncQuota('tickets', { current: (t) => countFor(t.id) }),
  (req, res) => {
    const list = (tickets.get(req.bridgeTenant!.id) ?? []).filter((id) => id !== req.params.id);
    tickets.set(req.bridgeTenant!.id, list);
    res.json({ ok: true });
  },
);

// A counter: exports happen, so Bridge counts them. Who may export is a flag;
// how many is the quota. A retry with the same Idempotency-Key counts once.
app.post(
  '/exports',
  bridge.protect({ featureFlag: 'exports-enabled' }),
  bridge.requireQuota('exports'),
  (_req, res) => {
    res.json({ exported: true });
  },
);

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

// Unified backend surface — the tenant view for the verified user.
app.get('/me/subscription', async (req, res) => {
  res.json({ subscription: await bridge.fromRequest(req).subscription });
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
  console.log('  GET    /health            — public (ANONYMOUS)');
  console.log('  GET    /api/public/info   — public (bridge.public() middleware)');
  console.log('  GET    /items             — protected (any authenticated user)');
  console.log("  GET    /reports/summary   — 'reports' flag (config rule)");
  console.log("  GET    /admin/users       — 'admin-panel' flag (protect middleware)");
  console.log("  GET    /beta/feature      — 'beta-access' flag");
  console.log("  POST   /tickets           — 'tickets' quota (gauge)");
  console.log("  DELETE /tickets/:id       — keeps the 'tickets' gauge in step");
  console.log("  POST   /exports           — 'exports-enabled' flag + 'exports' quota (counter)");
  console.log('  POST   /integrations/sync — API token (x-api-key) with TENANT_WRITE');
  console.log('  GET    /me/subscription   — bridge.fromRequest(req)');
  console.log('  GET    /forward/items     — token forwarding demo');
});

export { app };
