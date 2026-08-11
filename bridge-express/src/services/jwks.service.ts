import {
  JwksService as CoreJwksService,
  TokenVerificationError as CoreTokenVerificationError,
} from '@nebulr-group/bridge-auth-core/backend';
import type { ApiTokenClaims as CoreApiTokenClaims } from '@nebulr-group/bridge-auth-core/backend';
import { BridgeConfigService } from './bridge-config.service';
import { JwtClaims } from '../types/user';

/**
 * Claims present in a Bridge API token JWT.
 *
 * Re-exported from auth-core/backend so existing imports
 * (`import { ApiTokenClaims } from '../services/jwks.service'`) keep working.
 */
export type ApiTokenClaims = CoreApiTokenClaims;

/**
 * Error class for token verification failures.
 *
 * Re-exported from auth-core/backend so existing `instanceof TokenVerificationError`
 * checks and imports keep working unchanged. (Same class — not a subclass — so
 * `instanceof` is identical regardless of which path threw it.)
 */
export const TokenVerificationError = CoreTokenVerificationError;
export type TokenVerificationError = CoreTokenVerificationError;

/**
 * Express wrapper around the framework-agnostic auth-core JwksService.
 *
 * Lazily constructs the core service on first use so the JWKS-config values
 * (which `BridgeConfigService` derives from the Bridge config) are read at
 * request time. Public method signatures are unchanged from the previous
 * jose-based implementation; `verifyApiToken` is new.
 */
export class JwksService {
  private core: CoreJwksService | null = null;

  constructor(private readonly configService: BridgeConfigService) {}

  private getCore(): CoreJwksService {
    if (!this.core) {
      this.core = new CoreJwksService({
        jwksUrl: this.configService.jwksUrl,
        introspectionUrl: this.configService.introspectionUrl,
        introspectionCacheTtlMs: this.configService.introspectionCacheTtlMs,
        issuer: this.configService.authBaseUrl,
        audience: this.configService.appId,
        log: (message, ...args) => this.configService.log(message, ...args),
      });
    }
    return this.core;
  }

  /**
   * Verify a user JWT token and return the claims.
   *
   * @param token - The JWT token to verify
   * @returns The verified JWT claims
   * @throws TokenVerificationError if token is invalid
   */
  async verifyToken(token: string): Promise<JwtClaims> {
    return this.getCore().verifyToken(token) as Promise<JwtClaims>;
  }

  /**
   * Verify a Bridge API token JWT and return the claims.
   *
   * API tokens are signed with the per-app HS256 secret (which this app never
   * holds), so they are verified by POSTing them to the Bridge introspection
   * endpoint rather than locally.
   *
   * @param token - The JWT API token to verify
   * @param expectedAppId - The app ID the token should be issued for
   * @returns The verified API token claims
   * @throws TokenVerificationError if token is invalid, expired, wrong type, or wrong app
   */
  async verifyApiToken(token: string, expectedAppId: string): Promise<ApiTokenClaims> {
    return this.getCore().verifyApiToken(token, expectedAppId) as Promise<ApiTokenClaims>;
  }
}
