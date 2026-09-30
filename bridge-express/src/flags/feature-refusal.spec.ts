// TBP-756 — a flag-gated route says why it refused: 402 FEATURE_NOT_IN_PLAN
// when an upgrade alone would turn the feature on, 403 FEATURE_NOT_PERMITTED
// for a role/privilege reason, 403 FEATURE_OFF otherwise — for both
// `protect({ featureFlag })` and a route rule's `featureFlag`, from the reason
// Bridge's evaluate endpoint sends with an off flag.

import { featureRefusalBody } from './feature-refusal';
import { FeatureFlagService } from '../services/feature-flag.service';
import { createAuthMiddleware, createProtectMiddleware } from '../middleware/auth.middleware';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('featureRefusalBody', () => {
  it('plan → 402 FEATURE_NOT_IN_PLAN with the upgrade path and the feature', () => {
    expect(featureRefusalBody('analytics', { reason: 'plan', feature: 'reports' }, '/billing')).toEqual({
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      error: 'Payment Required',
      message: "Your plan does not include 'reports'. Upgrade to use it.",
      flag: 'analytics',
      reason: 'plan',
      feature: 'reports',
      fix: '/billing',
    });
  });

  it('permission → 403 FEATURE_NOT_PERMITTED', () => {
    expect(featureRefusalBody('admin', { reason: 'permission' })).toMatchObject({
      statusCode: 403,
      code: 'FEATURE_NOT_PERMITTED',
      flag: 'admin',
      fix: 'Ask a workspace admin for access.',
    });
  });

  it.each(['off', 'rule', 'rollout', undefined] as const)('%s → 403 FEATURE_OFF', (reason) => {
    const body = featureRefusalBody('beta', reason ? { reason } : {});
    expect(body).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF', flag: 'beta', error: 'Forbidden' });
    expect(body.message).toBe("Feature flag 'beta' is not enabled");
    expect(typeof body.fix).toBe('string');
  });

  it('plan without a manageRoute defaults to /subscription', () => {
    expect(featureRefusalBody('x', { reason: 'plan' }).fix).toBe('/subscription');
  });
});

// ── protect() / route rules — Bridge's evaluate endpoint ─────────────────────

describe('flag-gated routes refuse with the reason', () => {
  const claims = { sub: 'user-1', tid: 'tenant-1', role: 'USER', email: 'u@x.test' };

  function build(
    evaluations: Array<{ flag: string; evaluation: Record<string, unknown> }>,
    manageRoute = '/subscription',
  ) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ flags: evaluations }),
    }) as any;
    const configService: any = {
      log: jest.fn(),
      findMatchingRule: jest.fn().mockReturnValue(null),
      defaultAccess: 'protected',
      appId: 'app-1',
      cloudViewsBaseUrl: 'http://bridge.test/cloud-views',
      manageRoute,
    };
    const jwks: any = { verifyToken: jest.fn().mockResolvedValue(claims), verifyApiToken: jest.fn() };
    const flags = new FeatureFlagService(configService);
    const bridgeService: any = { fromJwt: jest.fn() };
    return {
      protect: (featureFlag: unknown) =>
        createProtectMiddleware(configService, jwks, flags, bridgeService, { featureFlag: featureFlag as any }),
      auth: () => createAuthMiddleware(configService, jwks, flags, bridgeService),
      configService,
    };
  }

  async function run(mw: any): Promise<{ status: number; body: any; next: jest.Mock }> {
    const req: any = { path: '/x/y', method: 'GET', headers: { authorization: 'Bearer token' } };
    const res: any = {
      _status: 0,
      _body: undefined,
      set() {
        return this;
      },
      status(code: number) {
        this._status = code;
        return this;
      },
      json(body: any) {
        this._body = body;
        return this;
      },
    };
    const next = jest.fn();
    await mw(req, res, next);
    return { status: res._status, body: res._body, next };
  }

  it('plan reason from Bridge → 402 FEATURE_NOT_IN_PLAN with the feature and fix', async () => {
    const { protect } = build(
      [{ flag: 'analytics', evaluation: { enabled: false, reason: 'plan', feature: 'reports' } }],
      '/billing/upgrade',
    );
    const r = await run(protect('analytics'));
    expect(r.next).not.toHaveBeenCalled();
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      flag: 'analytics',
      feature: 'reports',
      fix: '/billing/upgrade',
    });
  });

  it('permission reason → 403 FEATURE_NOT_PERMITTED', async () => {
    const { protect } = build([{ flag: 'admin', evaluation: { enabled: false, reason: 'permission' } }]);
    const r = await run(protect('admin'));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ statusCode: 403, error: 'Forbidden', code: 'FEATURE_NOT_PERMITTED', flag: 'admin' });
  });

  it('off reason, and a Bridge that sends no reason → 403 FEATURE_OFF keeping the old message', async () => {
    for (const evaluation of [{ enabled: false, reason: 'off' }, { enabled: false }]) {
      const { protect } = build([{ flag: 'beta', evaluation }]);
      const r = await run(protect('beta'));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({
        statusCode: 403,
        error: 'Forbidden',
        code: 'FEATURE_OFF',
        flag: 'beta',
        message: "Feature flag 'beta' is not enabled",
      });
    }
  });

  it('{ any }: an upgrade alone opens one of them → 402', async () => {
    const { protect } = build([
      { flag: 'a', evaluation: { enabled: false, reason: 'permission' } },
      { flag: 'b', evaluation: { enabled: false, reason: 'plan' } },
    ]);
    const r = await run(protect({ any: ['a', 'b'] }));
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN' });
  });

  it('{ all }: another failing flag is a permission → 403 FEATURE_NOT_PERMITTED', async () => {
    const { protect } = build([
      { flag: 'a', evaluation: { enabled: false, reason: 'plan' } },
      { flag: 'b', evaluation: { enabled: false, reason: 'permission' } },
    ]);
    const r = await run(protect({ all: ['a', 'b'] }));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_PERMITTED' });
  });

  it('a route rule featureFlag via auth() refuses the same way', async () => {
    const { auth, configService } = build([
      { flag: 'reports', evaluation: { enabled: false, reason: 'plan', feature: 'reports' } },
    ]);
    configService.findMatchingRule.mockReturnValue({ path: '/x/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' });
    const r = await run(auth());
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', flag: 'reports', fix: '/subscription' });
  });

  it('an enabled flag passes', async () => {
    const { protect } = build([{ flag: 'beta', evaluation: { enabled: true } }]);
    const r = await run(protect('beta'));
    expect(r.next).toHaveBeenCalled();
    expect(r.status).toBe(0);
  });
});

describe('FeatureFlagService reasons', () => {
  const configService: any = {
    log: jest.fn(),
    appId: 'app-1',
    cloudViewsBaseUrl: 'http://bridge.test/cloud-views',
  };

  it('a single-flag evaluation records the reason', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) =>
      url.includes('bulkEvaluate')
        ? { ok: true, json: async () => ({ flags: [] }) }
        : { ok: true, json: async () => ({ enabled: false, reason: 'plan', feature: 'exports' }) },
    ) as any;
    const svc = new FeatureFlagService(configService);
    await expect(svc.isEnabled('exports_flag', 'tok')).resolves.toBe(false);
    expect(svc.getReason('exports_flag', 'tok')).toEqual({ reason: 'plan', feature: 'exports' });
  });

  it('reasons are per token and cleared with the cache', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: [{ flag: 'f', evaluation: { enabled: false, reason: 'permission' } }] }),
    }) as any;
    const svc = new FeatureFlagService(configService);
    await svc.isEnabled('f', 'tok-a');
    expect(svc.getReason('f', 'tok-a')).toEqual({ reason: 'permission' });
    expect(svc.getReason('f', 'tok-b')).toBeUndefined();
    svc.clearCache();
    expect(svc.getReason('f', 'tok-a')).toBeUndefined();
  });
});
