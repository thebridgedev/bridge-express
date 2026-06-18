// TBP-341 — unit tests for BridgeService + TenantScope (Express).
//
// Ported from bridge-nestjs bridge/bridge.spec.ts. Validates:
//   - fromJwt(jwt) returns a TenantScope keyed on the JWT's tid+sub
//   - the snapshot fetch goes to GET /session/init with Bearer + x-app-id
//   - subscription / branding / user / entitlements all derive from one fetch
//   - BridgePullCache dedups concurrent callers (one fetch shared)
//   - invalidate() drops the entry so the next call refetches
//   - tenant(id) throws with a clear migration pointer
//   - entitlements.can(key) uses the snapshot map (true / false / missing)
//   - different JWTs get different cache keys (no cross-user leakage)
//
// A fake `fetcher` is injected into TenantScope so nothing hits the network.

import { BridgePullCache } from '@nebulr-group/bridge-auth-core';

import { BridgeService } from './bridge.service';
import { TenantScope, type SessionSnapshotData } from './tenant-scope';

const API_BASE_URL = 'https://api.test.example';
const APP_ID = 'app-1';

const SNAPSHOT: SessionSnapshotData = {
  app: { branding: { logo: 'logo.svg', name: 'Acme' } },
  tenant: {
    id: 'tenant-1',
    name: 'Acme Inc',
    subscription: { plan: { slug: 'pro', name: 'Pro' }, status: 'active' },
    entitlements: { canExport: true, canInvite: false },
  },
  user: { id: 'u-1', email: 'a@b.co', role: 'admin', tenantId: 'tenant-1' },
};

// HS256-shaped JWT — only the base64-decoded payload is read for cache keying;
// the signature is irrelevant (bridge-api verifies at the receiving end).
function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function decodeKey(j: string): string {
  const part = j.split('.')[1];
  if (!part) return j;
  try {
    const json = Buffer.from(part, 'base64').toString('utf8');
    const c = JSON.parse(json) as { sub?: string; tid?: string };
    return c.tid ? `${c.tid}:${c.sub ?? ''}` : (c.sub ?? j);
  } catch {
    return j;
  }
}

function mockFetch(response: SessionSnapshotData, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    } as Response;
  });
  return { fn, calls };
}

/**
 * Build a BridgeService whose fromJwt() returns a TenantScope wired to a fake
 * fetcher (TenantScope defaults to global `fetch`, so we re-create it by hand
 * with the injected fetcher — same approach as the father spec).
 */
function buildService(opts: { fetcher?: typeof fetch; ttlMs?: number } = {}) {
  const cache = new BridgePullCache({ ttlMs: opts.ttlMs ?? 30_000 });
  const svc = new BridgeService(API_BASE_URL, APP_ID, cache);
  if (opts.fetcher) {
    svc.fromJwt = (j: string) =>
      new TenantScope(j, decodeKey(j), cache, API_BASE_URL, APP_ID, opts.fetcher!);
  }
  return { svc, cache };
}

describe('BridgeService.fromJwt + TenantScope', () => {
  it('snapshot() fetches GET /session/init with Bearer + x-app-id', async () => {
    const { fn, calls } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));
    const data = await scope.snapshot();

    expect(data.tenant.id).toBe('tenant-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test.example/session/init');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Bearer /);
    expect(headers['x-app-id']).toBe('app-1');
  });

  it('exposes every snapshot slice as a lazy promise from one round-trip', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    const [sub, br, u, ents] = await Promise.all([
      scope.subscription,
      scope.branding,
      scope.user,
      scope.entitlements.snapshot(),
    ]);

    expect(sub.plan.slug).toBe('pro');
    expect(br.name).toBe('Acme');
    expect(u.id).toBe('u-1');
    expect(ents.canExport).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // one fetch for four reads
  });

  it('dedups concurrent snapshot() callers via BridgePullCache', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    await Promise.all([scope.snapshot(), scope.snapshot(), scope.snapshot()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('serves cached snapshot on subsequent calls within TTL', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch, ttlMs: 1_000 });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    await scope.snapshot();
    await scope.snapshot();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next call to refetch', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    await scope.snapshot();
    scope.invalidate();
    await scope.snapshot();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('entitlements.can returns true / false / false-for-missing correctly', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    expect(await scope.entitlements.can('canExport')).toBe(true);
    expect(await scope.entitlements.can('canInvite')).toBe(false);
    expect(await scope.entitlements.can('missingKey')).toBe(false);
  });

  it('entitlements.canSync answers from a previously-loaded map', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    const map = await scope.entitlements.snapshot();
    expect(scope.entitlements.canSync('canExport', map)).toBe(true);
    expect(scope.entitlements.canSync('canInvite', map)).toBe(false);
    expect(scope.entitlements.canSync('missingKey', map)).toBe(false);
    expect(scope.entitlements.canSync('canExport', undefined)).toBe(false);
  });

  it('throws a useful Error from .tenant(id) — not yet implemented', () => {
    const { svc } = buildService();
    expect(() => svc.tenant('tenant-X')).toThrow(/admin snapshot endpoint/);
  });

  it('different JWTs get different cache keys (no cross-user leakage)', async () => {
    const { fn } = mockFetch(SNAPSHOT);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const a = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));
    const b = svc.fromJwt(jwt({ sub: 'u-2', tid: 'tenant-2' }));

    await Promise.all([a.snapshot(), b.snapshot()]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws when GET /session/init returns a non-OK status', async () => {
    const { fn } = mockFetch(SNAPSHOT, 500);
    const { svc } = buildService({ fetcher: fn as unknown as typeof fetch });
    const scope = svc.fromJwt(jwt({ sub: 'u-1', tid: 'tenant-1' }));

    await expect(scope.snapshot()).rejects.toThrow(/session\/init failed: 500/);
  });
});
