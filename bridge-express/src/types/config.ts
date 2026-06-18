/**
 * Feature flag requirement - can be a single flag, any of multiple flags, or all of multiple flags
 */
export type FeatureFlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };

/**
 * Privilege levels used to protect routes.
 * ANONYMOUS  — no authentication required
 * AUTHENTICATED — any valid JWT (user or API token)
 * USER_READ / USER_WRITE / TENANT_READ / TENANT_WRITE — specific privilege strings
 * that must appear in the user JWT's / API token's `privileges` claim.
 */
export type RoutePrivilege =
  | 'ANONYMOUS'
  | 'AUTHENTICATED'
  | 'USER_READ'
  | 'USER_WRITE'
  | 'TENANT_READ'
  | 'TENANT_WRITE'
  | string;

/**
 * Route rule for centralized guard configuration.
 * Provide either `path` (REST) or `graphqlOperation` (GraphQL) — or both.
 */
export interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;
  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers") */
  graphqlOperation?: string;
  /** Required privilege level for this route */
  privilege: RoutePrivilege;
  /** Optional plan restriction — tenant plan must be in this list */
  plans?: string[];
}

/**
 * Guard configuration for global or route-based protection
 */
export interface GuardConfig {
  /** Default access level when no rule matches */
  defaultAccess?: 'public' | 'protected';
  /** Route rules for centralized configuration */
  rules?: RouteRule[];
}

/**
 * Bridge configuration
 */
export interface BridgeConfig {
  /**
   * Your Bridge application ID
   * @required
   */
  appId: string;

  /**
   * Base URL for the Bridge API. All endpoints are derived from this.
   * @default 'https://api.thebridge.dev'
   */
  apiBaseUrl?: string;

  /**
   * Guard configuration
   */
  guard?: GuardConfig;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Override the token-introspection URL for API token verification.
   * API tokens are signed with the per-app HS256 secret (which this app never
   * holds), so they are verified by POSTing them to the Bridge rather than
   * locally. Override this in Docker when the container can't reach the public
   * apiBaseUrl.
   * @default {apiBaseUrl}/account/api-token/introspect
   */
  introspectionUrl?: string;

  /**
   * How long (ms) a successful API-token introspection is cached, keyed by
   * token. Trades revocation latency for fewer network calls. `0` disables
   * caching → every request introspects (instant revocation).
   * @default 0
   */
  introspectionCacheTtlMs?: number;

  /**
   * Override the JWKS URL for user JWT verification.
   * Useful in Docker when the container can't reach the public apiBaseUrl.
   * @default {apiBaseUrl}/auth/.well-known/jwks.json
   */
  userJwksUrl?: string;
}

/**
 * Default configuration values
 */
export const BRIDGE_DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  debug: false,
  defaultAccess: 'protected' as const,
} as const;
