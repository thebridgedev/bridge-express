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
    manageRoute: string;
  };

  constructor(config: BridgeConfig = {}) {
    config = resolveBridgeConfig(config);
    assertRouteRules(config.guard?.rules);
    this.config = {
      appId: config.appId!,
      apiBaseUrl: config.apiBaseUrl || BRIDGE_DEFAULTS.apiBaseUrl,
      debug: config.debug ?? BRIDGE_DEFAULTS.debug,
      guard: config.guard,
      introspectionUrl: config.introspectionUrl,
      introspectionCacheTtlMs: config.introspectionCacheTtlMs,
      userJwksUrl: config.userJwksUrl,
      manageRoute: config.billing?.manageRoute || BRIDGE_DEFAULTS.manageRoute,
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

  /**
   * The subscription page a refused request points at — `fix` in
   * `402 FEATURE_NOT_IN_PLAN` (TBP-756), `402 QUOTA_EXCEEDED` and
   * `403 ENTITLEMENT_REQUIRED` (TBP-745). `billing.manageRoute`, default
   * `/subscription`.
   */
  get manageRoute(): string {
    return this.config.manageRoute;
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

/**
 * TBP-745 — fill `appId` / `apiBaseUrl` / `debug` from the environment where
 * the caller left them out (`BRIDGE_APP_ID`, `BRIDGE_API_BASE_URL`,
 * `BRIDGE_DEBUG`). Explicit values win, including an explicit `debug: false`
 * over `BRIDGE_DEBUG=true`. Same precedence as bridge-nestjs `forRoot()`.
 */
export function resolveBridgeConfig(
  config: BridgeConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig & { appId: string } {
  const appId = config.appId || env.BRIDGE_APP_ID;
  if (!appId) {
    throw new Error(
      '[bridge-express] createBridge() needs an app id: pass `appId` or set BRIDGE_APP_ID.',
    );
  }
  return {
    ...config,
    appId,
    apiBaseUrl: config.apiBaseUrl || env.BRIDGE_API_BASE_URL || undefined,
    debug: config.debug ?? env.BRIDGE_DEBUG === 'true',
  };
}

/**
 * TBP-745 (the express side of TBP-705) — route rules only say whether a
 * route needs a signed-in caller; who gets it is a flag. A rule that still
 * gates on a role, a privilege, a plan or an entitlement fails at startup,
 * naming the flag setup to use instead, rather than being silently ignored
 * (which would open the route).
 */
export function assertRouteRules(rules: unknown): void {
  if (!Array.isArray(rules)) return;
  const problems: string[] = [];
  rules.forEach((raw, i) => {
    const rule = (raw ?? {}) as Record<string, unknown>;
    const where = `guard.rules[${i}]${describeRule(rule)}`;
    const privilege = rule.privilege;
    if (privilege !== 'ANONYMOUS' && privilege !== 'AUTHENTICATED') {
      const named = typeof privilege === 'string' ? privilege : 'USER_WRITE';
      problems.push(
        `${where} has privilege: ${JSON.stringify(privilege)}. A route rule's privilege is only 'ANONYMOUS' or 'AUTHENTICATED'. ` +
          `Use privilege: 'AUTHENTICATED' with featureFlag: '<flag-key>', and give that flag the rule \`privileges contains ${JSON.stringify(named)}\`. ` +
          `For API-token callers, use bridge.protect({ privilege: ${JSON.stringify(named)} }) on the route (API tokens only).`,
      );
    }
    if ('plans' in rule) {
      problems.push(
        `${where} uses \`plans\`, which was removed. Use featureFlag: '<flag-key>' and give that flag a rule on the plan feature it sells: \`bridge:billing.entitlement.<key> eq true\`.`,
      );
    }
    for (const field of ['entitlement', 'entitlements'] as const) {
      if (field in rule) {
        problems.push(entitlementProblem(where, field, rule[field]));
      }
    }
    if ('role' in rule || 'roles' in rule) {
      problems.push(
        `${where} uses \`${'role' in rule ? 'role' : 'roles'}\`, which route rules do not support. Use featureFlag: '<flag-key>' and give that flag a rule on a privilege (\`privileges contains "USER_WRITE"\`).`,
      );
    }
  });
  if (problems.length > 0) {
    throw new Error(
      `[bridge-express] Every gate is a flag — these route rules gate some other way:\n  - ${problems.join(
        '\n  - ',
      )}\nRun "npx @nebulr-group/bridge-cli check gates" to list every direct check.`,
    );
  }
}

/**
 * TBP-745 — the same check for `bridge.protect(options)`: `role`, `plans`,
 * `entitlement` and `entitlements` were removed. Thrown when the middleware is
 * created (at startup), never per request.
 */
export function assertProtectOptions(options: unknown): void {
  if (!options || typeof options !== 'object') return;
  const opts = options as Record<string, unknown>;
  const where = 'bridge.protect()';
  const problems: string[] = [];
  if ('role' in opts) {
    problems.push(
      `${where} uses \`role\`, which was removed. Use bridge.protect({ featureFlag: '<flag-key>' }) and give that flag a rule on a privilege (\`privileges contains "USER_WRITE"\`).`,
    );
  }
  if ('plans' in opts) {
    problems.push(
      `${where} uses \`plans\`, which was removed. Use bridge.protect({ featureFlag: '<flag-key>' }) and give that flag a rule on the plan feature it sells: \`bridge:billing.entitlement.<key> eq true\`.`,
    );
  }
  for (const field of ['entitlement', 'entitlements'] as const) {
    if (field in opts) problems.push(entitlementProblem(where, field, opts[field], true));
  }
  if (problems.length > 0) {
    throw new Error(
      `[bridge-express] Every gate is a flag — ${where} gates some other way:\n  - ${problems.join(
        '\n  - ',
      )}\nRun "npx @nebulr-group/bridge-cli check gates" to list every direct check.`,
    );
  }
}

function entitlementProblem(where: string, field: string, value: unknown, protect = false): string {
  const keys = ([] as unknown[]).concat(value as unknown[]).filter((k) => typeof k === 'string');
  const key = (keys[0] as string | undefined) ?? '<key>';
  const use = protect ? `bridge.protect({ featureFlag: '${key}' })` : `featureFlag: '${key}'`;
  return `${where} uses \`${field}\`, which was removed. Use ${use} and give that flag the rule \`bridge:billing.entitlement.${key} eq true\`.`;
}

function describeRule(rule: Record<string, unknown>): string {
  if (typeof rule.path === 'string') return ` (path '${rule.path}')`;
  if (typeof rule.graphqlOperation === 'string') return ` (graphqlOperation '${rule.graphqlOperation}')`;
  return '';
}
