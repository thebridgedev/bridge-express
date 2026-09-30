// TBP-745 — bridge.requireQuota / bridge.syncQuota / bridge.requireEntitlement
// and the plain BridgeQuotaService calls behind them.
//
// Driven the way an app drives them: a real Express app from createBridge(),
// real HTTP requests to it, the real BridgeService / TenantScope. Only two
// things are stubbed — token verification (JwksService.verifyToken maps a
// token to its claims) and the network: global `fetch` plays bridge-api, so
// every assertion is on the requests that would actually reach Bridge.

import { createHash } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { Express, NextFunction, Request, Response } from 'express';
import express = require('express');

import { createBridge, type BridgeExpressInstance } from '../bridge';
import type { QuotaSnapshot } from '../bridge/tenant-scope';
import { JwksService } from '../services/jwks.service';
import type { BridgeConfig } from '../types/config';
import { resetEntitlementNotes, USAGE_COUNTED_HEADER } from './quota.middleware';
import { BridgeRefusalError, QuotaExceededError } from './quota.service';

const API = 'https://api.test';
const APP = 'app-1';

/** token → verified claims */
const TOKENS: Record<string, { sub: string; tid: string }> = {
  'tok-a': { sub: 'user-a', tid: 'tenant-a' },
  'tok-b': { sub: 'user-b', tid: 'tenant-b' },
};

// ── bridge-api stand-in ────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body?: any;
  auth?: string;
}
let calls: Call[];
let quotas: Record<string, QuotaSnapshot | 'error'>;
let entitlements: Record<string, boolean> | 'error';
let gaugeStatus: number;
let realFetch: typeof fetch;

function quota(metric: string, over: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    metric,
    used: 0,
    limit: 5,
    remaining: 5,
    warningLevel: null,
    policy: 'hard',
    kind: 'counter',
    ...over,
  };
}

function json(status: number, body: unknown): globalThis.Response {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const bridgeApi = jest.fn(async (input: any, init: any = {}) => {
  const url = new URL(String(input));
  const method = (init.method ?? 'GET').toUpperCase();
  const call: Call = {
    method,
    path: url.pathname,
    auth: init.headers?.Authorization,
    body: init.body ? JSON.parse(init.body) : undefined,
  };
  calls.push(call);
  const quotaMatch = url.pathname.match(/^\/usage\/quota\/(.+)$/);
  if (quotaMatch) {
    const q = quotas[decodeURIComponent(quotaMatch[1])];
    if (q === 'error') return json(500, {});
    if (!q) return json(404, {});
    return json(200, q);
  }
  if (url.pathname.startsWith('/usage/gauge/')) return json(gaugeStatus, {});
  if (url.pathname === '/usage/ingest') return json(201, {});
  if (url.pathname === '/session/init') {
    if (entitlements === 'error') return json(500, {});
    return json(200, {
      app: { branding: {} },
      tenant: { id: 't', name: 't', subscription: {}, entitlements },
      user: {},
    });
  }
  return json(404, {});
});

// ── the app under test ─────────────────────────────────────────────────────

/** The app's own ticket store — what a gauge `current` counts. */
const tickets = {
  count: 3,
  seen: [] as string[],
  countFor(tenantId: string) {
    this.seen.push(tenantId);
    return this.count;
  },
};

function makeApp(config: BridgeConfig = {}): { app: Express; bridge: BridgeExpressInstance } {
  const bridge = createBridge({ appId: APP, apiBaseUrl: API, ...config });
  const app = express();
  // A public route (declared before auth()) has no verified workspace user.
  app.post('/public', bridge.requireQuota('exports'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(bridge.auth());

  const count = (t: { id: string }) => tickets.countFor(t.id);

  app.post('/tickets', bridge.requireQuota('tickets', { current: count }), (_req, res) => {
    tickets.count += 1;
    res.status(201).json({ ok: true });
  });
  app.delete('/tickets/:id', bridge.syncQuota('tickets', { current: count }), (_req, res) => {
    tickets.count -= 1;
    res.json({ ok: true });
  });
  app.post('/exports', bridge.requireQuota('exports'), (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/exports-fail', bridge.requireQuota('exports'), (_req, res) => {
    res.status(422).json({ error: 'bad input' });
  });
  app.post('/exports-throw', bridge.requireQuota('exports'), () => {
    throw new Error('boom');
  });
  app.post(
    '/pdf',
    bridge.requireEntitlement('pdf'),
    bridge.requireQuota('exports'),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.post('/invite', bridge.requireQuota('seats'), (_req, res) => {
    res.json({ ok: true });
  });
  // A route listing the same quota twice still checks and records once.
  app.post('/twice', bridge.requireQuota('exports'), bridge.requireQuota('exports'), (_req, res) => {
    res.json({ ok: true });
  });
  // Swallow the thrown handler's error quietly (Express's default handler logs it).
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  return { app, bridge };
}

let server: http.Server | undefined;

async function request(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = { authorization: 'Bearer tok-a' },
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  if (!server || (server as any).__app !== app) {
    await closeServer();
    server = http.createServer(app);
    (server as any).__app = app;
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  }
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function closeServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = undefined;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const idem = (tenant: string, metric: string, key: string) =>
  `idem-${createHash('sha256').update(`${tenant}\u0000${metric}\u0000${key}`).digest('hex')}`;

let warn: jest.SpyInstance;
const savedNodeEnv = process.env.NODE_ENV;

beforeAll(() => {
  realFetch = globalThis.fetch;
  (globalThis as any).fetch = bridgeApi;
});
afterAll(async () => {
  (globalThis as any).fetch = realFetch;
  await closeServer();
});

beforeEach(() => {
  calls = [];
  quotas = {};
  entitlements = {};
  gaugeStatus = 200;
  tickets.count = 3;
  tickets.seen = [];
  process.env.NODE_ENV = 'test';
  resetEntitlementNotes();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(JwksService.prototype, 'verifyToken').mockImplementation(async (token: string) => {
    const claims = TOKENS[token];
    if (!claims) throw new Error('bad token');
    return claims as any;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env.NODE_ENV = savedNodeEnv;
});

// ── counter ────────────────────────────────────────────────────────────────

describe('requireQuota — counter (something that happened)', () => {
  it('lets the request through under the limit and reports exactly one event after the 2xx', async () => {
    quotas.exports = quota('exports', { used: 2 });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.status).toBe(200);
    expect(writes()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/usage/ingest',
        auth: 'Bearer tok-a',
        body: expect.objectContaining({ metric: 'exports', value: 1 }),
      }),
    ]);
  });

  it('refuses at the limit with 402 QUOTA_EXCEEDED naming metric, numbers and where to upgrade', async () => {
    quotas.exports = quota('exports', { used: 5, limit: 5 });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      statusCode: 402,
      code: 'QUOTA_EXCEEDED',
      message: 'Your plan allows 5 exports; 5 are in use.',
      metric: 'exports',
      used: 5,
      limit: 5,
      fix: '/subscription',
    });
    expect(writes()).toEqual([]);
  });

  it('points `fix` at billing.manageRoute when configured', async () => {
    quotas.exports = quota('exports', { used: 5, limit: 5 });
    const { app } = makeApp({ billing: { manageRoute: '/account/billing' } });
    const res = await request(app, 'POST', '/exports');
    expect(res.body.fix).toBe('/account/billing');
  });

  it('a metered quota never refuses, even far past its allowance — it bills', async () => {
    quotas.exports = quota('exports', { used: 500, limit: 5, policy: 'metered' });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('a metric with no quota on the plan is unlimited, and still recorded', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.status).toBe(200);
    expect(writes()).toEqual([expect.objectContaining({ path: '/usage/ingest' })]);
  });

  it('fails closed with 503 when the quota cannot be read', async () => {
    quotas.exports = 'error';
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'QUOTA_UNAVAILABLE', metric: 'exports' });
    expect(writes()).toEqual([]);
  });

  it('a route listing the same quota twice checks and records once', async () => {
    quotas.exports = quota('exports');
    const { app } = makeApp();
    await request(app, 'POST', '/twice');
    expect(calls.filter((c) => c.path === '/usage/quota/exports')).toHaveLength(1);
    expect(writes()).toHaveLength(1);
  });
});

describe('usage is recorded only after a 2xx', () => {
  beforeEach(() => {
    quotas.exports = quota('exports');
  });

  it('a handler that answers 4xx records nothing', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports-fail');
    expect(res.status).toBe(422);
    expect(writes()).toEqual([]);
  });

  it('a handler that throws records nothing', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports-throw');
    expect(res.status).toBe(500);
    expect(writes()).toEqual([]);
  });

  it('the write reaches Bridge before the client sees the 2xx', async () => {
    const { app } = makeApp();
    await request(app, 'POST', '/exports');
    // No waiting: the response only arrives once the write was made.
    expect(writes()).toHaveLength(1);
  });
});

describe('Idempotency-Key (counter mode) — workspace-scoped and hashed (TBP-738)', () => {
  beforeEach(() => {
    quotas.exports = quota('exports');
  });

  it('the same header sends the same key, so a retried export is one event', async () => {
    const { app } = makeApp();
    await request(app, 'POST', '/exports', { authorization: 'Bearer tok-a', 'idempotency-key': 'k1' });
    await request(app, 'POST', '/exports', { authorization: 'Bearer tok-a', 'idempotency-key': 'k1' });
    const keys = writes().map((c) => c.body.idempotencyKey);
    expect(keys).toEqual([idem('tenant-a', 'exports', 'k1'), idem('tenant-a', 'exports', 'k1')]);
  });

  it('the raw client key is never sent', async () => {
    const { app } = makeApp();
    await request(app, 'POST', '/exports', { authorization: 'Bearer tok-a', 'idempotency-key': 'k1' });
    expect(writes()[0].body.idempotencyKey).not.toContain('k1');
    expect(writes()[0].body.idempotencyKey).toMatch(/^idem-[0-9a-f]{64}$/);
  });

  it('is scoped to the verified tenant: another workspace reusing the key cannot swallow the event', async () => {
    const { app } = makeApp();
    await request(app, 'POST', '/exports', { authorization: 'Bearer tok-a', 'idempotency-key': 'k1' });
    await request(app, 'POST', '/exports', { authorization: 'Bearer tok-b', 'idempotency-key': 'k1' });
    const [a, b] = writes().map((c) => c.body.idempotencyKey);
    expect(a).toBe(idem('tenant-a', 'exports', 'k1'));
    expect(b).toBe(idem('tenant-b', 'exports', 'k1'));
    expect(a).not.toBe(b);
  });

  it('without the header every request counts (a fresh key each time)', async () => {
    const { app } = makeApp();
    await request(app, 'POST', '/exports');
    await request(app, 'POST', '/exports');
    const [a, b] = writes().map((c) => c.body.idempotencyKey);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('a spoofed x-bridge-context header does not change the tenant the key is scoped to (TBP-671)', async () => {
    const { app } = makeApp();
    await request(app, 'POST', '/exports', {
      authorization: 'Bearer tok-a',
      'idempotency-key': 'k1',
      'x-bridge-context': JSON.stringify({ tenantId: 'tenant-b' }),
    });
    expect(writes()[0].body.idempotencyKey).toBe(idem('tenant-a', 'exports', 'k1'));
  });
});

// ── gauge ──────────────────────────────────────────────────────────────────

describe('requireQuota — gauge (something that exists)', () => {
  it("compares the app's own count, not Bridge's stored value", async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', used: 0, limit: 3 });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/tickets');
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'QUOTA_EXCEEDED', metric: 'tickets', used: 3, limit: 3 });
    expect(writes()).toEqual([]);
  });

  it('after the 2xx sets the gauge to the new count — one PUT, no counter event', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', used: 3, limit: 10 });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/tickets');
    expect(res.status).toBe(201);
    expect(writes()).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/usage/gauge/tickets', body: { value: 4 } }),
    ]);
  });

  it('counts for the verified tenant', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', limit: 10 });
    const { app } = makeApp();
    await request(app, 'POST', '/tickets', { authorization: 'Bearer tok-b' });
    expect(tickets.seen).toEqual(['tenant-b', 'tenant-b']);
  });

  it('a metered policy never refuses, whatever the count', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', limit: 1, policy: 'metered' });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/tickets');
    expect(res.status).toBe(201);
  });

  it('a gauge write that fails does not fail the response (the next create/delete heals it)', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', limit: 10 });
    gaugeStatus = 500;
    const { app } = makeApp();
    const res = await request(app, 'POST', '/tickets');
    expect(res.status).toBe(201);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not set the 'tickets' gauge"),
      expect.anything(),
    );
  });

  it('seats (a gauge counted from membership) are checked, never reported, and need no count', async () => {
    quotas.seats = quota('seats', { kind: 'gauge', source: 'membership', used: 2, limit: 5 });
    const { app } = makeApp();
    const ok = await request(app, 'POST', '/invite');
    expect(ok.status).toBe(200);
    expect(writes()).toEqual([]);
    quotas.seats = quota('seats', { kind: 'gauge', source: 'membership', used: 5, limit: 5 });
    const refused = await request(app, 'POST', '/invite');
    expect(refused.status).toBe(402);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('syncQuota', () => {
  it('never checks the limit, and after the 2xx sets the gauge to the lower count', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', used: 9, limit: 1 });
    const { app } = makeApp();
    const res = await request(app, 'DELETE', '/tickets/1');
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.path.startsWith('/usage/quota'))).toEqual([]);
    expect(writes()).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/usage/gauge/tickets', body: { value: 2 } }),
    ]);
  });

  it('needs a count function', () => {
    const bridge = createBridge({ appId: APP, apiBaseUrl: API });
    expect(() => bridge.syncQuota('tickets', {} as any)).toThrow(/needs a `current` count function/);
  });

  it('requireQuota and syncQuota on the same metric write the gauge once', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', limit: 10 });
    const bridge = createBridge({ appId: APP, apiBaseUrl: API });
    const app = express();
    app.use(bridge.auth());
    const count = (t: { id: string }) => tickets.countFor(t.id);
    app.post(
      '/both',
      bridge.requireQuota('tickets', { current: count }),
      bridge.syncQuota('tickets', { current: count }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    await request(app, 'POST', '/both');
    expect(writes()).toHaveLength(1);
  });
});

// ── entitlement ────────────────────────────────────────────────────────────

describe('requireEntitlement', () => {
  it('refuses with 403 ENTITLEMENT_REQUIRED before the quota is even read', async () => {
    quotas.exports = quota('exports');
    entitlements = { pdf: false };
    const { app } = makeApp();
    const res = await request(app, 'POST', '/pdf');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      statusCode: 403,
      code: 'ENTITLEMENT_REQUIRED',
      message: "Your plan does not include 'pdf'.",
      entitlement: 'pdf',
      fix: '/subscription',
    });
    expect(calls.filter((c) => c.path.startsWith('/usage/'))).toEqual([]);
  });

  it('lets a tenant holding the entitlement through to the quota', async () => {
    quotas.exports = quota('exports');
    entitlements = { pdf: true };
    const { app } = makeApp();
    const res = await request(app, 'POST', '/pdf');
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('fails closed with 503 when entitlements cannot be read', async () => {
    entitlements = 'error';
    const { app } = makeApp();
    const res = await request(app, 'POST', '/pdf');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE', entitlement: 'pdf' });
  });

  it('outside production logs a one-time note naming the flag rule to use instead', async () => {
    entitlements = { pdf: true };
    quotas.exports = quota('exports');
    const { app } = makeApp();
    await request(app, 'POST', '/pdf');
    await request(app, 'POST', '/pdf');
    const notes = warn.mock.calls.filter((c) => String(c[0]).includes("requireEntitlement('pdf')"));
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toContain('bridge:billing.entitlement.pdf');
  });

  it('is silent in production', async () => {
    process.env.NODE_ENV = 'production';
    entitlements = { pdf: true };
    const { app } = makeApp();
    await request(app, 'POST', '/pdf');
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('requireEntitlement'))).toEqual([]);
  });
});

// ── identity ───────────────────────────────────────────────────────────────

describe('identity comes from the verified token only', () => {
  it('401 and nothing sent when no user token was verified on the request', async () => {
    quotas.exports = quota('exports');
    const { app } = makeApp();
    const res = await request(app, 'POST', '/public', {});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401, message: 'A signed-in workspace user is required' });
    expect(calls).toEqual([]);
  });

  it('a req.bridgeAccessToken set by other code is not a verified token', async () => {
    const bridge = createBridge({ appId: APP, apiBaseUrl: API });
    const app = express();
    app.use((req, _res, next) => {
      req.bridgeAccessToken = 'tok-a';
      next();
    });
    app.post('/x', bridge.requireQuota('exports'), (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app, 'POST', '/x', {});
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('calls Bridge with the verified token', async () => {
    quotas.exports = quota('exports');
    const { app } = makeApp();
    await request(app, 'POST', '/exports', { authorization: 'Bearer tok-b' });
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-b', 'Bearer tok-b']);
  });
});

// ── the plain calls ────────────────────────────────────────────────────────

describe('BridgeQuotaService — the same calls, without middleware', () => {
  function serviceApp(handler: (bridge: BridgeExpressInstance, req: Request, res: Response) => Promise<void>) {
    const bridge = createBridge({ appId: APP, apiBaseUrl: API });
    const app = express();
    app.use(bridge.auth());
    app.post('/svc', async (req, res) => {
      try {
        await handler(bridge, req, res);
      } catch (e) {
        if (e instanceof BridgeRefusalError) res.status(e.status).json(e.body);
        else res.status(500).json({ error: String(e) });
      }
    });
    return app;
  }

  it('check() answers without refusing; assertQuota() refuses with the same 402', async () => {
    quotas.exports = quota('exports', { used: 5, limit: 5 });
    let decision: any;
    const app = serviceApp(async (bridge, req, res) => {
      decision = await bridge.quota.check(req, 'exports');
      await bridge.quota.assertQuota(req, 'exports');
      res.json({});
    });
    const res = await request(app, 'POST', '/svc');
    expect(decision).toMatchObject({ allowed: false, used: 5, limit: 5 });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
  });

  it('assertQuota() throws a QuotaExceededError carrying status and body', async () => {
    quotas.exports = quota('exports', { used: 5, limit: 5 });
    let caught: unknown;
    const app = serviceApp(async (bridge, req, res) => {
      try {
        await bridge.quota.assertQuota(req, 'exports');
      } catch (e) {
        caught = e;
      }
      res.json({});
    });
    await request(app, 'POST', '/svc');
    expect(caught).toBeInstanceOf(QuotaExceededError);
    expect((caught as QuotaExceededError).status).toBe(402);
  });

  it('record() makes exactly one write per call: PUT for a gauge, POST for a counter', async () => {
    const app = serviceApp(async (bridge, req, res) => {
      await bridge.quota.record(req, 'tickets', { current: 7 });
      await bridge.quota.record(req, 'exports', { value: 3, idempotencyKey: 'job-1' });
      res.json({});
    });
    await request(app, 'POST', '/svc');
    expect(writes()).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/usage/gauge/tickets', body: { value: 7 } }),
      expect.objectContaining({
        method: 'POST',
        path: '/usage/ingest',
        body: { metric: 'exports', value: 3, idempotencyKey: idem('tenant-a', 'exports', 'job-1') },
      }),
    ]);
  });

  it('assertEntitlement() refuses with the same 403', async () => {
    entitlements = {};
    const app = serviceApp(async (bridge, req, res) => {
      await bridge.quota.assertEntitlement(req, 'sso');
      res.json({});
    });
    const res = await request(app, 'POST', '/svc');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', entitlement: 'sso' });
  });

  it('bridge.fromRequest(req).usage reaches the same endpoints', async () => {
    quotas.exports = quota('exports', { used: 1 });
    let snapshot: any;
    const app = serviceApp(async (bridge, req, res) => {
      snapshot = await bridge.fromRequest(req).usage.quota('exports');
      res.json({});
    });
    await request(app, 'POST', '/svc');
    expect(snapshot).toMatchObject({ metric: 'exports', used: 1 });
  });
});

// ── the dev header ─────────────────────────────────────────────────────────

describe('X-Bridge-Usage-Counted (outside production only) — TBP-697', () => {
  const header = USAGE_COUNTED_HEADER.toLowerCase();

  it('a counter endpoint names its metric on the 2xx and exposes the header to cross-origin pages', async () => {
    quotas.exports = quota('exports');
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.headers[header]).toBe('exports');
    expect(res.headers['access-control-expose-headers']).toContain(USAGE_COUNTED_HEADER);
  });

  it('a gauge endpoint and syncQuota name theirs', async () => {
    quotas.tickets = quota('tickets', { kind: 'gauge', limit: 10 });
    const { app } = makeApp();
    expect((await request(app, 'POST', '/tickets')).headers[header]).toBe('tickets');
    expect((await request(app, 'DELETE', '/tickets/1')).headers[header]).toBe('tickets');
  });

  it('a 402 refusal carries it too (the browser sees the metric even at the cap)', async () => {
    quotas.exports = quota('exports', { used: 5, limit: 5 });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.status).toBe(402);
    expect(res.headers[header]).toBe('exports');
  });

  it('a gauge Bridge keeps (seats, counted from membership) is only checked here, so it is not named', async () => {
    quotas.seats = quota('seats', { kind: 'gauge', source: 'membership' });
    const { app } = makeApp();
    const res = await request(app, 'POST', '/invite');
    expect(res.headers[header]).toBeUndefined();
  });

  it('NODE_ENV=production: no header at all', async () => {
    process.env.NODE_ENV = 'production';
    quotas.exports = quota('exports');
    const { app } = makeApp();
    const res = await request(app, 'POST', '/exports');
    expect(res.headers[header]).toBeUndefined();
  });
});

describe('createBridge() reads its settings from the environment when given none', () => {
  it('boots with no arguments from BRIDGE_APP_ID / BRIDGE_API_BASE_URL', async () => {
    const saved = { ...process.env };
    process.env.BRIDGE_APP_ID = APP;
    process.env.BRIDGE_API_BASE_URL = API;
    try {
      quotas.exports = quota('exports');
      const bridge = createBridge();
      const app = express();
      app.use(bridge.auth());
      app.post('/e', bridge.requireQuota('exports'), (_req, res) => {
        res.json({});
      });
      const res = await request(app, 'POST', '/e');
      expect(res.status).toBe(200);
      expect(calls[0].path).toBe('/usage/quota/exports');
    } finally {
      delete process.env.BRIDGE_APP_ID;
      delete process.env.BRIDGE_API_BASE_URL;
      Object.assign(process.env, saved);
    }
  });

  it('refuses to start without an app id', () => {
    const saved = process.env.BRIDGE_APP_ID;
    delete process.env.BRIDGE_APP_ID;
    try {
      expect(() => createBridge()).toThrow(/pass `appId` or set BRIDGE_APP_ID/);
    } finally {
      if (saved !== undefined) process.env.BRIDGE_APP_ID = saved;
    }
  });
});
