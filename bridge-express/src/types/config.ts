/**
 * Feature flag requirement - can be a single flag, any of multiple flags, or all of multiple flags
 */
export type FeatureFlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };

/**
 * Route rule for centralized guard configuration
 */
export interface RouteRule {
  /** Path pattern to match (supports * wildcard) */
  path: string;
  /** Mark route as public (no auth required) */
  public?: boolean;
  /** Required role for this route */
  role?: string;
  /** Required feature flag(s) for this route */
  featureFlag?: FeatureFlagRequirement;
  /** HTTP methods this rule applies to (defaults to all) */
  methods?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD')[];
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
   * The base URL for Bridge auth services
   * @default 'https://auth.nblocks.cloud'
   */
  authBaseUrl?: string;

  /**
   * The base URL for Bridge backendless services
   * @default 'https://backendless.nblocks.cloud'
   */
  backendlessBaseUrl?: string;

  /**
   * Guard configuration
   */
  guard?: GuardConfig;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * Default configuration values
 */
export const BRIDGE_DEFAULTS = {
  authBaseUrl: 'https://auth.nblocks.cloud',
  backendlessBaseUrl: 'https://backendless.nblocks.cloud',
  debug: false,
  defaultAccess: 'protected' as const,
} as const;
