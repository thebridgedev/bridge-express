// Unit tests for the Express dual-path auth middleware (TBP-341).
//
// Ported from bridge-nestjs BridgeAuthGuard.spec.ts — same behavior, Express
// idiom. We mock the service boundary (jwksService.verifyToken /
// verifyApiToken, featureFlagService.evaluateRequirement) so nothing hits the
// network. `TokenVerificationError` is imported from the wrapper, which
// re-exports the real auth-core class — `instanceof` checks in the middleware
// rely on that identity.
//
// Express idiom vs NestJS guard:
//   - auth()    reads config route rules + defaultAccess (the global-guard analogue)
//   - protect() always enforces auth and ignores config rules; its options ARE the rule
//   - public()  sets req.__bridgePublic so auth() skips
//   - 401/403 are written to `res` and `next` is NOT called (vs guard throwing)

import {
  createAuthMiddleware,
  createProtectMiddleware,
  createPublicMiddleware,
} from './auth.middleware';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError, ApiTokenClaims } from '../services/jwks.service';
import { FeatureFlagService } from '../services/feature-flag.service';
import { BridgeService } from '../bridge/bridge.service';

// Minimal user JWT claims for testing
const mockClaims = {
  sub: 'user-1',
  email: 'test@example.com',
  email_verified: true,
  preferred_username: 'test',
  name: 'Test User',
  tid: 'tenant-1',
  role: 'USER',
};

const mockApiTokenClaims: ApiTokenClaims = {
  sub: 'token-1',
  appId: 'test-app-id',
  tenantId: null,
  type: 'api',
  privileges: ['USER_READ', 'TENANT_READ'],
};

function makeReqRes(overrides: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  bridgePublic?: boolean;
  bridgeApiToken?: ApiTokenClaims;
}): { req: any; res: any; next: jest.Mock } {
  const req: any = {
    path: overrides.path ?? '/items',
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? {},
    __bridgePublic: overrides.bridgePublic,
    bridgeApiToken: overrides.bridgeApiToken,
  };
  const res: any = {
    _headers: {} as Record<string, string>,
    _status: 0,
    _body: null as any,
    set(name: string, value: string) {
      this._headers[name] = value;
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
  return { req, res, next };
}

describe('auth middleware', () => {
  let configService: jest.Mocked<BridgeConfigService>;
  let jwksService: jest.Mocked<JwksService>;
  let featureFlagService: jest.Mocked<FeatureFlagService>;
  let bridgeService: jest.Mocked<BridgeService>;
  // The TenantScope returned by bridgeService.fromJwt(); its .snapshot() is the
  // single fetch the guard uses to resolve subscription plan + entitlements.
  let snapshotMock: jest.Mock;

  beforeEach(() => {
    configService = {
      log: jest.fn(),
      findMatchingRule: jest.fn().mockReturnValue(null),
      defaultAccess: 'protected',
      appId: 'test-app-id',
    } as any;

    jwksService = {
      verifyToken: jest.fn(),
      verifyApiToken: jest.fn(),
    } as any;

    featureFlagService = {
      evaluateRequirement: jest.fn(),
    } as any;

    snapshotMock = jest.fn();
    bridgeService = {
      fromJwt: jest.fn().mockReturnValue({ snapshot: snapshotMock }),
    } as any;
  });

  function auth() {
    return createAuthMiddleware(configService, jwksService, featureFlagService, bridgeService);
  }
  function protect(options?: any) {
    return createProtectMiddleware(
      configService,
      jwksService,
      featureFlagService,
      bridgeService,
      options,
    );
  }

  describe('createPublicMiddleware', () => {
    it('sets __bridgePublic flag and calls next', () => {
      const { req, res, next } = makeReqRes({});
      createPublicMiddleware()(req, res, next);

      expect(req.__bridgePublic).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('auth() — public routes', () => {
    it('calls next when __bridgePublic flag is set (bridge.public())', async () => {
      const { req, res, next } = makeReqRes({ bridgePublic: true });
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('calls next when config rule privilege is ANONYMOUS', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/health', privilege: 'ANONYMOUS' });
      const { req, res, next } = makeReqRes({ path: '/health' });
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('calls next when defaultAccess is public and no rule matches', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      (configService as any).defaultAccess = 'public';
      const { req, res, next } = makeReqRes({});
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('auth() — missing credential', () => {
    it('returns 401 missing_token when no Authorization or x-api-key header', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      const { req, res, next } = makeReqRes({ headers: {} });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('missing_token');
    });
  });

  describe('auth() — user JWT verification errors (RFC 6750)', () => {
    const cases: Array<[string, string]> = [
      ['TOKEN_EXPIRED', 'expired_token'],
      ['TOKEN_INVALID', 'invalid_token'],
      ['JWKS_NO_MATCH', 'invalid_token'],
      ['CLAIM_VALIDATION_FAILED', 'invalid_token'],
      ['APP_MISMATCH', 'invalid_token'],
    ];

    for (const [code, expectedError] of cases) {
      it(`returns 401 ${expectedError} when verifyToken throws ${code}`, async () => {
        configService.findMatchingRule.mockReturnValue(null);
        jwksService.verifyToken.mockRejectedValue(new TokenVerificationError('boom', code));

        const { req, res, next } = makeReqRes({
          headers: { authorization: 'Bearer some.token.here' },
        });
        await auth()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(401);
        expect(res._headers['WWW-Authenticate']).toContain(expectedError);
      });
    }

    it('returns 401 invalid_token when Authorization header is present but malformed', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      const { req, res, next } = makeReqRes({ headers: { authorization: 'NotBearer xyz' } });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('returns 401 invalid_token on a non-TokenVerificationError thrown by verifyToken', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(new Error('network blew up'));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer a.b.c' } });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });
  });

  describe('auth() — valid user JWT', () => {
    it('attaches bridgeUser, bridgeTenant and bridgeAccessToken', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer valid.token.here' },
      });
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeUser).toBeDefined();
      expect(req.bridgeUser.id).toBe('user-1');
      expect(req.bridgeTenant).toBeDefined();
      expect(req.bridgeTenant.id).toBe('tenant-1');
      expect(req.bridgeAccessToken).toBe('valid.token.here');
    });
  });

  describe('auth() — route-rule privilege (user JWT path)', () => {
    it('returns 403 when user lacks the required route privilege', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'TENANT_WRITE' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // no privileges

      const { req, res, next } = makeReqRes({
        path: '/admin/users',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('passes when user has the required route privilege', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'TENANT_WRITE' });
      jwksService.verifyToken.mockResolvedValue({ ...mockClaims, privileges: ['TENANT_WRITE'] } as any);

      const { req, res, next } = makeReqRes({
        path: '/admin/users',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('allows AUTHENTICATED route privilege for any valid JWT', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'AUTHENTICATED' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        path: '/admin/users',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('protect() — role checks (user JWT path)', () => {
    it('returns 403 when user role does not match the required role', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ role: 'ADMIN' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('passes when user role matches the required role', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ role: 'USER' })(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('protect() — feature flag checks (user JWT path)', () => {
    it('delegates to FeatureFlagService and passes when the flag is enabled', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(true);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ featureFlag: 'beta-access' })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(featureFlagService.evaluateRequirement).toHaveBeenCalledWith('beta-access', 'token');
    });

    it('returns 403 when the required feature flag is disabled', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(false);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ featureFlag: 'premium-feature' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe('protect() — always enforces auth', () => {
    it('returns 401 even when defaultAccess is public', async () => {
      (configService as any).defaultAccess = 'public';
      const { req, res, next } = makeReqRes({ headers: {} });
      await protect()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('missing_token');
    });

    it('does NOT consult config route rules (options are the rule)', async () => {
      // A config rule that would normally deny TENANT_WRITE must be ignored by protect().
      configService.findMatchingRule.mockReturnValue({ path: '/items', privilege: 'TENANT_WRITE' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // no privileges

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(configService.findMatchingRule).not.toHaveBeenCalled();
    });

    it('calls next when token is valid and no options are provided', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeUser).toBeDefined();
    });
  });

  describe('protect() — API token path (x-api-key)', () => {
    it('verifies a JWT-shaped API key, attaches req.bridgeApiToken, returns 200', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeApiToken).toEqual(mockApiTokenClaims);
      expect(jwksService.verifyApiToken).toHaveBeenCalledWith('valid.api.token', 'test-app-id');
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('returns 401 invalid_token when API token introspection reports APP_MISMATCH', async () => {
      jwksService.verifyApiToken.mockRejectedValue(
        new TokenVerificationError('Different app', 'APP_MISMATCH'),
      );

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'wrong.app.token' } });
      await protect()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });

    it('returns 401 expired_token when the API token is expired', async () => {
      jwksService.verifyApiToken.mockRejectedValue(
        new TokenVerificationError('Token expired', 'TOKEN_EXPIRED'),
      );

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'expired.api.token' } });
      await protect()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('expired_token');
    });

    it('treats an opaque (non-JWT-shaped) x-api-key as no API token → 401 missing_token', async () => {
      // An opaque key is not introspected and provides no context; with no
      // Authorization header either, the request has no valid credential.
      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'opaque-key-no-dots' } });
      await protect()(req, res, next);

      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('missing_token');
    });

    it('trusts a pre-processed req.bridgeApiToken and does NOT re-verify', async () => {
      const { req, res, next } = makeReqRes({
        headers: { 'x-api-key': 'pre.processed.token' },
        bridgeApiToken: mockApiTokenClaims,
      });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
      expect(req.bridgeApiToken).toEqual(mockApiTokenClaims);
    });
  });

  describe('protect() — privilege option (API-token path only)', () => {
    it('passes when the required privilege is present in the API token', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect({ privilege: 'USER_READ' })(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when the required privilege is missing from the API token', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims); // USER_READ, TENANT_READ

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect({ privilege: 'ADMIN_WRITE' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('returns 403 when the API token has an empty privileges array', async () => {
      jwksService.verifyApiToken.mockResolvedValue({ ...mockApiTokenClaims, privileges: [] });

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect({ privilege: 'USER_READ' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('a user JWT bypasses the privilege option entirely (no API token present)', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer user.jwt.token' } });
      await protect({ privilege: 'ADMIN_WRITE' })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });
  });

  describe('protect() — dual credential coexistence (TBP-118)', () => {
    it('only Bearer JWT → bridgeUser set, bridgeApiToken unset', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer user.jwt.token' } });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeUser).toBeDefined();
      expect(req.bridgeApiToken).toBeUndefined();
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });

    it('only x-api-key → bridgeApiToken set, bridgeUser unset', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeApiToken).toEqual(mockApiTokenClaims);
      expect(req.bridgeUser).toBeUndefined();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('both valid Bearer JWT + x-api-key → BOTH contexts coexist on req', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: {
          authorization: 'Bearer user.jwt.token',
          'x-api-key': 'valid.api.token',
        },
      });
      await protect()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeApiToken).toEqual(mockApiTokenClaims);
      expect(req.bridgeUser).toBeDefined();
      expect(req.bridgeUser.id).toBe('user-1');
      expect(req.bridgeAccessToken).toBe('user.jwt.token');
      expect(jwksService.verifyApiToken).toHaveBeenCalled();
      expect(jwksService.verifyToken).toHaveBeenCalled();
    });

    it('both headers but Bearer JWT invalid → 401 (JWT branch validates even when API key is valid)', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('Token expired', 'TOKEN_EXPIRED'),
      );

      const { req, res, next } = makeReqRes({
        headers: {
          authorization: 'Bearer expired.jwt',
          'x-api-key': 'valid.api.token',
        },
      });
      await protect()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it('both headers + @RequirePrivilege the API token lacks → 403 (API-side denial enforced)', async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims); // USER_READ, TENANT_READ
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: {
          authorization: 'Bearer user.jwt.token',
          'x-api-key': 'valid.api.token',
        },
      });
      await protect({ privilege: 'ADMIN_WRITE' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe('protect() — acceptAuth', () => {
    it("acceptAuth: 'jwt' + API token only (x-api-key) → 401 invalid_request", async () => {
      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect({ acceptAuth: 'jwt' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_request');
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });

    it("acceptAuth: 'jwt' + user JWT → 200", async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer user.jwt.token' } });
      await protect({ acceptAuth: 'jwt' })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).toHaveBeenCalled();
    });

    it("acceptAuth: 'jwt' + BOTH Bearer JWT + x-api-key → 200 (API key ignored, JWT honored)", async () => {
      // cloud-views always sends both headers; @AcceptAuth('jwt') must route
      // through the JWT branch and skip API-token verification.
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: {
          authorization: 'Bearer user.jwt.token',
          'x-api-key': 'valid.api.token',
        },
      });
      await protect({ acceptAuth: 'jwt' })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeUser).toBeDefined();
      expect(req.bridgeUser.id).toBe('user-1');
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });

    it("acceptAuth: 'api_token' + user JWT (Authorization Bearer) → 401 invalid_request", async () => {
      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer user.jwt.token' } });
      await protect({ acceptAuth: 'api_token' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_request');
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it("acceptAuth: 'api_token' + API token → 200", async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect({ acceptAuth: 'api_token' })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeApiToken).toEqual(mockApiTokenClaims);
    });

    it("acceptAuth: 'both' (default) + API token → 200", async () => {
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const { req, res, next } = makeReqRes({ headers: { 'x-api-key': 'valid.api.token' } });
      await protect({ acceptAuth: 'both' })(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("acceptAuth: 'both' (default) + user JWT → 200", async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer user.jwt.token' } });
      await protect({ acceptAuth: 'both' })(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // TBP-472 — plan / entitlement / feature-flag gating for the user-JWT path.
  // Plan and entitlement failures are 402 Payment Required; feature-flag
  // failures are 403 Forbidden. The plan/entitlement state is resolved from the
  // tenant snapshot via bridgeService.fromJwt(token).snapshot(). Any failure to
  // determine that state (fetch error) fails closed → 402 billing_locked.
  function snapshotWith(plan: string, entitlements: Record<string, boolean> = {}) {
    return {
      app: { branding: {} },
      tenant: {
        id: 'tenant-1',
        name: 'Test Tenant',
        subscription: { plan: { slug: plan, name: plan }, status: 'active' },
        entitlements,
      },
      user: { id: 'user-1', role: 'USER', tenantId: 'tenant-1' },
    };
  }

  describe('protect() — plan gating (402 Payment Required)', () => {
    it('passes when the tenant plan is in the allowed list', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('pro'));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ plans: ['pro', 'enterprise'] })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(bridgeService.fromJwt).toHaveBeenCalledWith('token');
    });

    it('returns 402 plan_required when the tenant plan is not allowed', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('free'));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ plans: ['pro', 'enterprise'] })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body).toEqual({
        error: 'Payment required',
        reason: 'plan_required',
        requiredPlan: 'pro, enterprise',
      });
    });

    it('enforces plans declared on a config route rule via auth()', async () => {
      configService.findMatchingRule.mockReturnValue({
        path: '/premium/*',
        privilege: 'AUTHENTICATED',
        plans: ['pro'],
      });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('free'));

      const { req, res, next } = makeReqRes({
        path: '/premium/report',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body.reason).toBe('plan_required');
    });
  });

  describe('protect() — entitlement gating (402 Payment Required)', () => {
    it('passes when the required entitlement is present', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('pro', { export: true }));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ entitlement: 'export' })(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 402 entitlement_missing when the entitlement is absent', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('pro', { export: false }));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ entitlement: 'export' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body).toEqual({
        error: 'Payment required',
        reason: 'entitlement_missing',
        requiredEntitlement: 'export',
      });
    });

    it('requires ALL entitlements when an array is given (402 on first missing)', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('pro', { export: true, api: false }));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ entitlements: ['export', 'api'] })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body.reason).toBe('entitlement_missing');
      expect(res._body.requiredEntitlement).toBe('api');
    });

    it('enforces entitlement declared on a config route rule via auth()', async () => {
      configService.findMatchingRule.mockReturnValue({
        path: '/export/*',
        privilege: 'AUTHENTICATED',
        entitlement: 'export',
      });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockResolvedValue(snapshotWith('pro', {}));

      const { req, res, next } = makeReqRes({
        path: '/export/csv',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body.reason).toBe('entitlement_missing');
    });
  });

  describe('protect() — fail-closed on snapshot fetch error (402 billing_locked)', () => {
    it('returns 402 billing_locked when the snapshot fetch throws (plan rule)', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockRejectedValue(new Error('GET /session/init failed: 500'));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ plans: ['pro'] })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body).toEqual({ error: 'Payment required', reason: 'billing_locked' });
    });

    it('returns 402 billing_locked when the snapshot fetch throws (entitlement rule)', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      snapshotMock.mockRejectedValue(new Error('network blew up'));

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ entitlement: 'export' })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(402);
      expect(res._body.reason).toBe('billing_locked');
    });

    it('does NOT fetch the snapshot when no plan/entitlement rule is present', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({ headers: { authorization: 'Bearer token' } });
      await protect({ role: 'USER' })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(bridgeService.fromJwt).not.toHaveBeenCalled();
    });
  });

  describe('protect() — feature-flag gating from a config route rule (403 Forbidden)', () => {
    it('passes when the route-rule feature flag is enabled', async () => {
      configService.findMatchingRule.mockReturnValue({
        path: '/beta/*',
        privilege: 'AUTHENTICATED',
        featureFlag: 'beta-access',
      });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(true);

      const { req, res, next } = makeReqRes({
        path: '/beta/thing',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(featureFlagService.evaluateRequirement).toHaveBeenCalledWith('beta-access', 'token');
    });

    it('returns 403 when the route-rule feature flag is disabled', async () => {
      configService.findMatchingRule.mockReturnValue({
        path: '/beta/*',
        privilege: 'AUTHENTICATED',
        featureFlag: 'beta-access',
      });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(false);

      const { req, res, next } = makeReqRes({
        path: '/beta/thing',
        headers: { authorization: 'Bearer token' },
      });
      await auth()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });
});
