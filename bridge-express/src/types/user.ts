/**
 * Authenticated user extracted from JWT access token
 */
export interface BridgeUser {
  /** User ID (sub claim) */
  id: string;
  /** User's email address */
  email: string;
  /** Whether email is verified */
  emailVerified: boolean;
  /** Username (preferred_username claim) */
  username: string;
  /** Full display name */
  fullName: string;
  /** Given/first name */
  givenName?: string;
  /** Family/last name */
  familyName?: string;
  /** User's locale preference */
  locale?: string;
  /** Whether user has completed onboarding */
  onboarded?: boolean;
  /** Tenant/workspace ID the user is authenticated for */
  tenantId: string;
  /** App ID from the token (aid claim) */
  appId?: string;
  /** OAuth scopes granted to the token */
  scope?: string;
  /** User's role within the tenant */
  role?: string;
  /** Whether user has multi-tenant access */
  multiTenantAccess?: boolean;
}

/**
 * Raw JWT claims from the access/ID token
 */
export interface JwtClaims {
  /** Subject (user ID) */
  sub: string;
  /** Preferred username */
  preferred_username?: string;
  /** Email address */
  email?: string;
  /** Email verified flag */
  email_verified?: boolean;
  /** Full name */
  name?: string;
  /** Given name */
  given_name?: string;
  /** Family name */
  family_name?: string;
  /** Locale */
  locale?: string;
  /** User onboarded flag */
  onboarded?: boolean;
  /** Multi-tenant flag */
  multi_tenant?: boolean;
  /** Tenant ID (long form) */
  tenant_id?: string;
  /** Tenant ID (short form - nblocks format) */
  tid?: string;
  /** App ID (short form - nblocks format) */
  aid?: string;
  /** Scope (nblocks format) */
  scope?: string;
  /** Tenant name */
  tenant_name?: string;
  /** Tenant locale */
  tenant_locale?: string;
  /** Tenant logo URL */
  tenant_logo?: string;
  /** Tenant onboarded flag */
  tenant_onboarded?: boolean;
  /** User's role */
  role?: string;
  /** Token issuer */
  iss?: string;
  /** Token audience */
  aud?: string | string[];
  /** Expiration time */
  exp?: number;
  /** Not before time */
  nbf?: number;
  /** Issued at time */
  iat?: number;
}

/**
 * Transform raw JWT claims into BridgeUser
 */
export function transformJwtToBridgeUser(claims: JwtClaims): BridgeUser {
  return {
    id: claims.sub,
    email: claims.email || '',
    emailVerified: claims.email_verified || false,
    username: claims.preferred_username || claims.email || '',
    fullName: claims.name || '',
    givenName: claims.given_name,
    familyName: claims.family_name,
    locale: claims.locale,
    onboarded: claims.onboarded,
    tenantId: claims.tid || claims.tenant_id || '',
    appId: claims.aid,
    scope: claims.scope,
    role: claims.role,
    multiTenantAccess: claims.multi_tenant,
  };
}
