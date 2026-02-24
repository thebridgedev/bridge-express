// jose is ESM-only; mock it so CJS jest can load the module graph
jest.mock('jose', () => {
  class JWTExpired extends Error {
    constructor(message: string, payload?: any, claim?: string, reason?: string) {
      super(message);
      this.name = 'JWTExpired';
    }
  }
  class JWTInvalid extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'JWTInvalid';
    }
  }
  class JWKSNoMatchingKey extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'JWKSNoMatchingKey';
    }
  }
  class JWTClaimValidationFailed extends Error {
    constructor(message: string, payload?: any, claim?: string, reason?: string) {
      super(message);
      this.name = 'JWTClaimValidationFailed';
    }
  }
  return {
    createRemoteJWKSet: jest.fn(),
    jwtVerify: jest.fn(),
    errors: { JWTExpired, JWTInvalid, JWKSNoMatchingKey, JWTClaimValidationFailed },
  };
});

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { JwksService, TokenVerificationError } from './jwks.service';
import { BridgeConfigService } from './bridge-config.service';

const mockConfigService = {
  jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
  authBaseUrl: 'https://auth.example.com',
  appId: 'test-app',
  log: jest.fn(),
} as unknown as BridgeConfigService;

const mockJwks = jest.fn();

describe('JwksService', () => {
  let service: JwksService;

  beforeEach(() => {
    jest.clearAllMocks();
    (createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwks);
    service = new JwksService(mockConfigService);
  });

  describe('verifyToken', () => {
    it('should return JWT claims on successful verification', async () => {
      const claims = { sub: 'user-1', email: 'test@example.com', tid: 'tenant-1' };
      (jwtVerify as jest.Mock).mockResolvedValue({ payload: claims });

      const result = await service.verifyToken('valid.token');
      expect(result).toEqual(claims);
    });

    it('should throw TokenVerificationError with TOKEN_EXPIRED for expired tokens', async () => {
      const expiredError = new joseErrors.JWTExpired('token expired', {});
      (jwtVerify as jest.Mock).mockRejectedValue(expiredError);

      await expect(service.verifyToken('expired.token')).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
      });
    });

    it('should throw TokenVerificationError with TOKEN_INVALID for invalid tokens', async () => {
      const invalidError = new joseErrors.JWTInvalid('token invalid');
      (jwtVerify as jest.Mock).mockRejectedValue(invalidError);

      await expect(service.verifyToken('invalid.token')).rejects.toMatchObject({
        code: 'TOKEN_INVALID',
      });
    });

    it('should throw TokenVerificationError with JWKS_NO_MATCH when no matching key', async () => {
      const noKeyError = new joseErrors.JWKSNoMatchingKey();
      (jwtVerify as jest.Mock).mockRejectedValue(noKeyError);

      await expect(service.verifyToken('token')).rejects.toMatchObject({
        code: 'JWKS_NO_MATCH',
      });
    });

    it('should throw TokenVerificationError with CLAIM_VALIDATION_FAILED for claim errors', async () => {
      const claimError = new joseErrors.JWTClaimValidationFailed('claim failed', {}, 'iss', 'check_failed');
      (jwtVerify as jest.Mock).mockRejectedValue(claimError);

      await expect(service.verifyToken('token')).rejects.toMatchObject({
        code: 'CLAIM_VALIDATION_FAILED',
      });
    });
  });

  describe('JWKS caching', () => {
    it('should only call createRemoteJWKSet once within TTL', async () => {
      (jwtVerify as jest.Mock).mockResolvedValue({ payload: { sub: 'user-1' } });

      await service.verifyToken('token1');
      await service.verifyToken('token2');

      expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
    });
  });
});
