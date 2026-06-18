// The Express JwksService is a thin wrapper that delegates to the
// framework-agnostic auth-core/backend JwksService (TBP-341). We mock that
// module so we control both verifyToken and verifyApiToken, and assert the
// wrapper constructs the core with the config-derived values and delegates.
//
// `TokenVerificationError` must be a real class (the middleware uses
// `instanceof`), so the mock provides a concrete class that the wrapper
// re-exports unchanged.

class MockTokenVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

const mockVerifyToken = jest.fn();
const mockVerifyApiToken = jest.fn();
const coreCtorSpy = jest.fn();

jest.mock('@nebulr-group/bridge-auth-core/backend', () => ({
  JwksService: jest.fn().mockImplementation((config: unknown) => {
    coreCtorSpy(config);
    return {
      verifyToken: mockVerifyToken,
      verifyApiToken: mockVerifyApiToken,
    };
  }),
  TokenVerificationError: MockTokenVerificationError,
}));

import { JwksService, TokenVerificationError } from './jwks.service';
import { BridgeConfigService } from './bridge-config.service';

const mockConfigService = {
  jwksUrl: 'https://api.example.com/auth/.well-known/jwks.json',
  introspectionUrl: 'https://api.example.com/account/api-token/introspect',
  introspectionCacheTtlMs: 0,
  authBaseUrl: 'https://api.example.com/auth',
  appId: 'test-app',
  log: jest.fn(),
} as unknown as BridgeConfigService;

describe('JwksService (Express wrapper over auth-core/backend)', () => {
  let service: JwksService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new JwksService(mockConfigService);
  });

  describe('lazy core construction', () => {
    it('does NOT construct the core until first use', () => {
      // Constructing the wrapper alone must not touch the core.
      expect(coreCtorSpy).not.toHaveBeenCalled();
    });

    it('constructs the core once with config-derived values, reused across calls', async () => {
      mockVerifyToken.mockResolvedValue({ sub: 'user-1' });

      await service.verifyToken('token1');
      await service.verifyToken('token2');

      expect(coreCtorSpy).toHaveBeenCalledTimes(1);
      const config = coreCtorSpy.mock.calls[0][0];
      expect(config).toMatchObject({
        jwksUrl: 'https://api.example.com/auth/.well-known/jwks.json',
        introspectionUrl: 'https://api.example.com/account/api-token/introspect',
        introspectionCacheTtlMs: 0,
        issuer: 'https://api.example.com/auth',
        audience: 'test-app',
      });
      expect(typeof config.log).toBe('function');
    });
  });

  describe('verifyToken', () => {
    it('delegates to the core and returns JWT claims on success', async () => {
      const claims = { sub: 'user-1', email: 'test@example.com', tid: 'tenant-1' };
      mockVerifyToken.mockResolvedValue(claims);

      const result = await service.verifyToken('valid.token');

      expect(result).toEqual(claims);
      expect(mockVerifyToken).toHaveBeenCalledWith('valid.token');
    });

    it('propagates a TOKEN_EXPIRED TokenVerificationError from the core', async () => {
      mockVerifyToken.mockRejectedValue(
        new MockTokenVerificationError('Token expired', 'TOKEN_EXPIRED'),
      );

      await expect(service.verifyToken('expired.token')).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
      });
    });

    it('propagates a TOKEN_INVALID TokenVerificationError from the core', async () => {
      mockVerifyToken.mockRejectedValue(
        new MockTokenVerificationError('Invalid token', 'TOKEN_INVALID'),
      );

      await expect(service.verifyToken('invalid.token')).rejects.toMatchObject({
        code: 'TOKEN_INVALID',
      });
    });

    it('propagates a JWKS_NO_MATCH TokenVerificationError from the core', async () => {
      mockVerifyToken.mockRejectedValue(
        new MockTokenVerificationError('No matching key', 'JWKS_NO_MATCH'),
      );

      await expect(service.verifyToken('token')).rejects.toMatchObject({
        code: 'JWKS_NO_MATCH',
      });
    });

    it('re-exports the SAME TokenVerificationError class as the core (instanceof works)', async () => {
      const err = new MockTokenVerificationError('Token expired', 'TOKEN_EXPIRED');
      mockVerifyToken.mockRejectedValue(err);

      await expect(service.verifyToken('expired.token')).rejects.toBeInstanceOf(
        TokenVerificationError,
      );
    });
  });

  describe('verifyApiToken (introspection path, delegated to core)', () => {
    const apiTokenClaims = {
      sub: 'token-1',
      appId: 'test-app',
      tenantId: null,
      type: 'api' as const,
      privileges: ['USER_READ'],
    };

    it('delegates to the core verifyApiToken with the token + expected appId', async () => {
      mockVerifyApiToken.mockResolvedValue(apiTokenClaims);

      const claims = await service.verifyApiToken('api.token.here', 'test-app');

      expect(claims).toEqual(apiTokenClaims);
      expect(mockVerifyApiToken).toHaveBeenCalledWith('api.token.here', 'test-app');
      // API token path must NOT touch the user-JWT verifier.
      expect(mockVerifyToken).not.toHaveBeenCalled();
    });

    it('propagates TOKEN_INVALID when introspection reports the token inactive', async () => {
      mockVerifyApiToken.mockRejectedValue(
        new MockTokenVerificationError('Token inactive', 'TOKEN_INVALID'),
      );

      await expect(service.verifyApiToken('dead.token', 'test-app')).rejects.toMatchObject({
        code: 'TOKEN_INVALID',
      });
    });

    it('propagates APP_MISMATCH when the token belongs to a different app', async () => {
      mockVerifyApiToken.mockRejectedValue(
        new MockTokenVerificationError('Different app', 'APP_MISMATCH'),
      );

      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toMatchObject({
        code: 'APP_MISMATCH',
      });
    });

    it('propagates UNKNOWN_ERROR when the introspection request itself fails', async () => {
      mockVerifyApiToken.mockRejectedValue(
        new MockTokenVerificationError('ECONNREFUSED', 'UNKNOWN_ERROR'),
      );

      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toMatchObject({
        code: 'UNKNOWN_ERROR',
      });
    });
  });
});
