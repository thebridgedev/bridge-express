import { BridgeConfig, BRIDGE_DEFAULTS, RouteRule } from '../types/config';

/**
 * Service for accessing Bridge configuration
 */
export class BridgeConfigService {
  private readonly config: Required<
    Pick<BridgeConfig, 'appId' | 'authBaseUrl' | 'backendlessBaseUrl' | 'debug'>
  > & { guard: BridgeConfig['guard'] };

  constructor(config: BridgeConfig) {
    this.config = {
      appId: config.appId,
      authBaseUrl: config.authBaseUrl || BRIDGE_DEFAULTS.authBaseUrl,
      backendlessBaseUrl: config.backendlessBaseUrl || BRIDGE_DEFAULTS.backendlessBaseUrl,
      debug: config.debug ?? BRIDGE_DEFAULTS.debug,
      guard: config.guard,
    };
  }

  get appId(): string {
    return this.config.appId;
  }

  get authBaseUrl(): string {
    return this.config.authBaseUrl;
  }

  get backendlessBaseUrl(): string {
    return this.config.backendlessBaseUrl;
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
   * Get the JWKS URL for token verification
   */
  get jwksUrl(): string {
    return `${this.config.authBaseUrl}/.well-known/jwks.json`;
  }

  /**
   * Find a matching route rule for the given path and method
   */
  findMatchingRule(path: string, method: string): RouteRule | null {
    for (const rule of this.rules) {
      if (this.pathMatches(path, rule.path)) {
        // Check if method matches (if specified)
        if (rule.methods && rule.methods.length > 0) {
          if (!rule.methods.includes(method as any)) {
            continue;
          }
        }
        return rule;
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
