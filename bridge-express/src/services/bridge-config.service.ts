import { BridgeConfig, BRIDGE_DEFAULTS, RouteRule } from '../types/config';

/**
 * Service for accessing Bridge configuration
 */
export class BridgeConfigService {
  private readonly config: {
    appId: string;
    apiBaseUrl: string;
    debug: boolean;
    guard: BridgeConfig['guard'];
    introspectionUrl: string | undefined;
    introspectionCacheTtlMs: number | undefined;
    userJwksUrl: string | undefined;
  };

  constructor(config: BridgeConfig) {
    this.config = {
      appId: config.appId,
      apiBaseUrl: config.apiBaseUrl || BRIDGE_DEFAULTS.apiBaseUrl,
      debug: config.debug ?? BRIDGE_DEFAULTS.debug,
      guard: config.guard,
      introspectionUrl: config.introspectionUrl,
      introspectionCacheTtlMs: config.introspectionCacheTtlMs,
      userJwksUrl: config.userJwksUrl,
    };
  }

  get appId(): string {
    return this.config.appId;
  }

  /** Public read of the resolved API base URL (used by the unified BridgeService). */
  get apiBaseUrl(): string {
    return this.config.apiBaseUrl;
  }

  /** Derived: ${apiBaseUrl}/auth — used for JWT issuer validation */
  get authBaseUrl(): string {
    return `${this.config.apiBaseUrl}/auth`;
  }

  /** Derived: ${apiBaseUrl}/cloud-views — used for feature flag evaluation */
  get cloudViewsBaseUrl(): string {
    return `${this.config.apiBaseUrl}/cloud-views`;
  }

  get debug(): boolean {
    return this.config.debug;
  }

  get defaultAccess(): 'public' | 'protected' {
    return this.config.guard?.defaultAccess ?? BRIDGE_DEFAULTS.defaultAccess;
  }

  get rules(): RouteRule[] {
    return this.config.guard?.rules ?? [];
  }

  /**
   * JWKS URL for user token verification.
   * Uses userJwksUrl override if configured (for Docker), otherwise derived from apiBaseUrl.
   */
  get jwksUrl(): string {
    return this.config.userJwksUrl ?? `${this.authBaseUrl}/.well-known/jwks.json`;
  }

  /**
   * Token-introspection URL for API token verification.
   * Uses introspectionUrl override if configured, otherwise derived from
   * apiBaseUrl. Note: this lives directly under apiBaseUrl (NOT under /auth).
   */
  get introspectionUrl(): string {
    return (
      this.config.introspectionUrl ??
      `${this.config.apiBaseUrl}/account/api-token/introspect`
    );
  }

  /** How long (ms) successful introspections are cached. 0 = disabled. */
  get introspectionCacheTtlMs(): number | undefined {
    return this.config.introspectionCacheTtlMs;
  }

  /**
   * Find a matching route rule for the given path/method or GraphQL operation name.
   * @param path - the HTTP request path (e.g. '/account/tick')
   * @param method - the HTTP method (e.g. 'GET')
   * @param operationName - optional GraphQL operation name (e.g. 'listUsers')
   */
  findMatchingRule(path: string, method: string, operationName?: string): RouteRule | null {
    for (const rule of this.rules) {
      if (operationName) {
        // GraphQL request: match against graphqlOperation only
        if (rule.graphqlOperation && rule.graphqlOperation === operationName) {
          return rule;
        }
      } else {
        // REST request: match against path only
        if (rule.path && this.pathMatches(path, rule.path)) {
          return rule;
        }
      }
    }
    return null;
  }

  /**
   * Check if a path matches a pattern (supports * wildcard)
   */
  private pathMatches(path: string, pattern: string): boolean {
    // Normalize paths
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const normalizedPattern = pattern.startsWith('/') ? pattern : `/${pattern}`;

    // Convert pattern to regex
    const regexPattern = normalizedPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\\\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalizedPath);
  }

  /**
   * Log debug message if debug mode is enabled
   */
  log(message: string, ...args: any[]): void {
    if (this.config.debug) {
      console.log(`[Bridge] ${message}`, ...args);
    }
  }
}
