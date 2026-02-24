// jose is ESM-only; mock it so CJS jest can load the module graph
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
    JWTClaimValidationFailed: class extends Error {},
  },
}));

import { Request, Response, NextFunction } from 'express';
import {
  createAuthMiddleware,
  createProtectMiddleware,
  createPublicMiddleware,
} from './auth.middleware';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError } from '../services/jwks.service';
import { FeatureFlagService } from '../services/feature-flag.service';

// Minimal JWT claims for testing
const mockClaims = {
  sub: 'user-1',
  email: 'test@example.com',
  email_verified: true,
  preferred_username: 'test',
  name: 'Test User',
  tid: 'tenant-1',
  role: 'USER',
};

function makeReqRes(overrides: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  bridgePublic?: boolean;
}): { req: any; res: any; next: jest.Mock } {
  const req: any = {
    path: overrides.path ?? '/items',
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? {},
    __bridgePublic: overrides.bridgePublic,
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

  beforeEach(() => {
    configService = {
      log: jest.fn(),
      findMatchingRule: jest.fn().mockReturnValue(null),
      defaultAccess: 'protected',
    } as any;

    jwksService = {
      verifyToken: jest.fn(),
    } as any;

    featureFlagService = {
      evaluateRequirement: jest.fn(),
    } as any;
  });

  describe('createPublicMiddleware', () => {
    it('should set __bridgePublic flag and call next', () => {
      const { req, res, next } = makeReqRes({});
      const middleware = createPublicMiddleware();
      middleware(req, res, next);

      expect(req.__bridgePublic).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('createAuthMiddleware — public routes', () => {
    it('should call next when __bridgePublic flag is set', async () => {
      const { req, res, next } = makeReqRes({ bridgePublic: true });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('should call next when config rule marks route as public', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/health', public: true });
      const { req, res, next } = makeReqRes({ path: '/health' });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('should call next when defaultAccess is public and no rule matches', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      (configService as any).defaultAccess = 'public';
      const { req, res, next } = makeReqRes({});
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('createAuthMiddleware — missing token', () => {
    it('should return 401 with missing_token when no Authorization header', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      const { req, res, next } = makeReqRes({ headers: {} });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('missing_token');
    });
  });

  describe('createAuthMiddleware — token verification errors', () => {
    it('should return 401 with expired_token when token is expired', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('Token expired', 'TOKEN_EXPIRED'),
      );

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer expired.token.here' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('expired_token');
    });

    it('should return 401 with invalid_token when token is invalid', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('Invalid token', 'TOKEN_INVALID'),
      );

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer tampered.token.here' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });

    it('should return 401 with invalid_token when JWKS has no matching key', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('No matching key', 'JWKS_NO_MATCH'),
      );

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer some.token.here' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });
  });

  describe('createAuthMiddleware — valid token', () => {
    it('should attach bridgeUser, bridgeTenant, and bridgeAccessToken to request', async () => {
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer valid.token.here' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeUser).toBeDefined();
      expect(req.bridgeUser.id).toBe('user-1');
      expect(req.bridgeAccessToken).toBe('valid.token.here');
    });
  });

  describe('createAuthMiddleware — role checks', () => {
    it('should return 403 if user role does not match required role from config', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', role: 'ADMIN' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const { req, res, next } = makeReqRes({
        path: '/admin/users',
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('should call next when user role matches required role', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/items', role: 'USER' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('createAuthMiddleware — feature flag checks', () => {
    it('should delegate to FeatureFlagService when feature flag is required', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/beta/*', featureFlag: 'beta-access' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(true);

      const { req, res, next } = makeReqRes({
        path: '/beta/feature',
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(featureFlagService.evaluateRequirement).toHaveBeenCalledWith('beta-access', 'token');
    });

    it('should return 403 when feature flag is disabled', async () => {
      configService.findMatchingRule.mockReturnValue({ path: '/beta/*', featureFlag: 'beta-access' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(false);

      const { req, res, next } = makeReqRes({
        path: '/beta/feature',
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createAuthMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe('createProtectMiddleware', () => {
    it('should always require auth even when defaultAccess is public', async () => {
      (configService as any).defaultAccess = 'public';
      const { req, res, next } = makeReqRes({ headers: {} });
      const middleware = createProtectMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._headers['WWW-Authenticate']).toContain('missing_token');
    });

    it('should apply options.role override', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createProtectMiddleware(
        configService,
        jwksService,
        featureFlagService,
        { role: 'ADMIN' },
      );
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('should apply options.featureFlag override', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(false);

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createProtectMiddleware(
        configService,
        jwksService,
        featureFlagService,
        { featureFlag: 'premium-feature' },
      );
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('should call next when token is valid and no options provided', async () => {
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer token' },
      });
      const middleware = createProtectMiddleware(configService, jwksService, featureFlagService);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.bridgeUser).toBeDefined();
    });
  });
});
