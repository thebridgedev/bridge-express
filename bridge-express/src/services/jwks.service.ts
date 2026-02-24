import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { BridgeConfigService } from './bridge-config.service';
import { JwtClaims } from '../types/user';

/**
 * Service for JWKS-based JWT verification
 */
export class JwksService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksInitTime: number = 0;
  private readonly JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(private readonly configService: BridgeConfigService) {}

  /**
   * Initialize or refresh the JWKS client
   */
  private ensureJwks(): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();

    // Refresh JWKS if expired or not initialized
    if (!this.jwks || now - this.jwksInitTime > this.JWKS_CACHE_TTL_MS) {
      this.configService.log('Initializing JWKS client', { url: this.configService.jwksUrl });
      this.jwks = createRemoteJWKSet(new URL(this.configService.jwksUrl));
      this.jwksInitTime = now;
    }

    return this.jwks;
  }

  /**
   * Verify a JWT token and return the claims
   *
   * @param token - The JWT token to verify
   * @returns The verified JWT claims
   * @throws TokenVerificationError if token is invalid
   */
  async verifyToken(token: string): Promise<JwtClaims> {
    const jwks = this.ensureJwks();

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: this.configService.authBaseUrl,
        audience: this.configService.appId,
      });

      this.configService.log('Token verified successfully', {
        sub: payload.sub,
        iss: payload.iss,
        aud: payload.aud,
      });

      return payload as JwtClaims;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        this.configService.log('Token verification failed: Token expired');
        throw new TokenVerificationError('Token expired', 'TOKEN_EXPIRED');
      }
      if (error instanceof joseErrors.JWTInvalid) {
        this.configService.log('Token verification failed: Invalid token');
        throw new TokenVerificationError('Invalid token', 'TOKEN_INVALID');
      }
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        this.configService.log('Token verification failed: No matching key in JWKS');
        throw new TokenVerificationError('Invalid token signature', 'JWKS_NO_MATCH');
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        this.configService.log('Token verification failed: Claim validation failed', (error as Error).message);
        throw new TokenVerificationError('Token claim validation failed', 'CLAIM_VALIDATION_FAILED');
      }

      this.configService.log('Token verification failed: Unknown error', error);
      throw new TokenVerificationError('Token verification failed', 'UNKNOWN_ERROR');
    }
  }
}

/**
 * Error class for token verification failures
 */
export class TokenVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}
