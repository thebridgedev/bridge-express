import { Request, Response, NextFunction, RequestHandler } from 'express';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError, ApiTokenClaims } from '../services/jwks.service';
import { FeatureFlagService, RequirementVerdict } from '../services/feature-flag.service';
import { featureRefusalBody } from '../flags/feature-refusal';
import { BridgeService } from '../bridge/bridge.service';
import { rememberVerifiedUserToken } from '../bridge/verified-request';
import { assertProtectOptions } from '../services/bridge-config.service';
import { transformJwtToBridgeUser } from '../types/user';
import { transformJwtToBridgeTenant } from '../types/tenant';
import { FeatureFlagRequirement, RouteRule } from '../types/config';
import { BridgeUser } from '../types/user';
import { BridgeTenant } from '../types/tenant';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      bridgeUser?: BridgeUser;
      bridgeTenant?: BridgeTenant;
      bridgeAccessToken?: string;
      bridgeApiToken?: ApiTokenClaims;
      __bridgePublic?: boolean;
    }
  }
}

/**
 * Which credential types an endpoint accepts.
 * - `jwt` — user JWT (Authorization: Bearer) only
 * - `api_token` — Bridge API token (x-api-key) only
 * - `both` — either credential is accepted (default)
 */
export type AuthType = 'jwt' | 'api_token' | 'both';

/**
 * Maps TokenVerificationError codes to RFC 6750 error strings and descriptions.
 */
const TOKEN_ERROR_MAP: Record<string, { error: string; description: string }> = {
  TOKEN_EXPIRED: {
    error: 'expired_token',
    description: 'The access token has expired',
  },
  TOKEN_INVALID: {
    error: 'invalid_token',
    description: 'The access token is invalid',
  },
  JWKS_NO_MATCH: {
    error: 'invalid_token',
    description: 'The access token signature could not be verified',
  },
  CLAIM_VALIDATION_FAILED: {
    error: 'invalid_token',
    description: 'The access token claim validation failed',
  },
  APP_MISMATCH: {
    error: 'invalid_token',
    description: 'The access token was issued for a different application',
  },
};

export interface BridgeMiddlewareOptions {
  /**
   * API tokens only: the scope an API token (x-api-key) must carry to call
   * this route (the `@RequirePrivilege` analogue). It is not a gate on a
   * person — a signed-in user (Authorization: Bearer) is not checked against
   * it; gate people with `featureFlag` and a flag rule on a privilege
   * (`privileges contains "USER_READ"`).
   */
  privilege?: string;
  /**
   * Which credential types this route accepts (the `@AcceptAuth` analogue).
   * @default 'both'
   */
  acceptAuth?: AuthType;
  /**
   * The flag that decides who gets this route (the `@RequireFeatureFlag`
   * analogue — user JWT only). The flag's rule says why: a privilege, a plan
   * feature (`bridge:billing.entitlement.<key> eq true`) or a rollout.
   *
   * `role`, `plans`, `entitlement` and `entitlements` were removed in 0.7.0
   * (every gate is a flag); passing them throws when the middleware is created.
   */
  featureFlag?: FeatureFlagRequirement;
}

/** Shared dependencies threaded through the guard core. */
interface GuardDeps {
  configService: BridgeConfigService;
  jwksService: JwksService;
  featureFlagService: FeatureFlagService;
  bridgeService: BridgeService;
}

/**
 * Core guard logic shared by `auth()` and `protect()`.
 *
 * Mirrors the bridge-nestjs BridgeAuthGuard: validates JWT bearer tokens / API
 * tokens and enforces feature-flag requirements (people) and API-token
 * privileges (machines). The two
 * authentication paths are evaluated **independently** — when both an
 * `x-api-key` and an `Authorization: Bearer` header are present (cloud-views
 * always sends both), both contexts coexist on `request`.
 *
 * @returns `true` if the request may proceed; `false` if a 401/403 response was
 *          already written (the caller must NOT call `next()`).
 */
async function runGuard(
  req: Request,
  res: Response,
  deps: GuardDeps,
  matchingRule: RouteRule | null,
  options: BridgeMiddlewareOptions,
): Promise<boolean> {
  const { configService, jwksService, featureFlagService } = deps;

  // 4. Read accepted auth type (default: 'both')
  const acceptedType: AuthType = options.acceptAuth ?? 'both';

  // 5. Check x-api-key header (API token path)
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const hasAuthHeader = !!req.headers.authorization;
  let apiTokenClaims: ApiTokenClaims | null = null;

  // @AcceptAuth('jwt') semantics: the endpoint requires a user JWT for its
  // user-context decisions. When BOTH headers are present (cloud-views ALWAYS
  // sends both), we accept the request and let the JWT branch populate
  // `req.bridgeUser`. We only reject if the API token is the *only* credential
  // the caller offered.
  if (apiKey && acceptedType === 'jwt' && !hasAuthHeader) {
    configService.log('API token rejected — endpoint only accepts user JWTs');
    sendUnauthorized(
      res,
      'Bearer error="invalid_request", error_description="API token authentication is not accepted for this endpoint"',
      'auth type not accepted',
    );
    return false;
  }

  // When @AcceptAuth('jwt') and Bearer is present, the API key is informational
  // only — skip API-token verification entirely so its result doesn't trigger
  // privilege checks meant for the JWT path.
  const skipApiTokenForJwtOnly = acceptedType === 'jwt' && hasAuthHeader;

  if (apiKey && !skipApiTokenForJwtOnly) {
    if (req.bridgeApiToken) {
      // a. Pre-processed upstream — trust it, skip re-verification
      apiTokenClaims = req.bridgeApiToken;
      configService.log('API token pre-processed upstream', { appId: apiTokenClaims.appId });
    } else if (isJwtShaped(apiKey)) {
      // b. Standalone verification via introspection
      try {
        apiTokenClaims = await jwksService.verifyApiToken(apiKey, configService.appId);
        req.bridgeApiToken = apiTokenClaims;
        configService.log('API token verified', { appId: apiTokenClaims.appId });
      } catch (error) {
        if (error instanceof TokenVerificationError) {
          configService.log('API token verification failed', { code: error.code });
          const mapped = TOKEN_ERROR_MAP[error.code] ?? {
            error: 'invalid_token',
            description: 'The access token is invalid',
          };
          sendUnauthorized(
            res,
            `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
            mapped.description,
          );
          return false;
        }
        sendUnauthorized(
          res,
          'Bearer error="invalid_token", error_description="The access token is invalid"',
          'Access token missing or invalid',
        );
        return false;
      }
    }
    // c. else: non-JWT key (opaque) — no API token context, fall through to Authorization
  }

  // 6. User JWT path — extract and validate Authorization: Bearer token.
  //    Independent from the API-token path: when both credentials are present
  //    and valid, both contexts coexist on `req`.
  const authHeader = req.headers.authorization;
  let user: BridgeUser | null = null;
  let token: string | null = null;

  if (authHeader && acceptedType === 'api_token') {
    configService.log('User JWT rejected — endpoint only accepts API tokens');
    sendUnauthorized(
      res,
      'Bearer error="invalid_request", error_description="User JWT authentication is not accepted for this endpoint"',
      'auth type not accepted',
    );
    return false;
  }

  if (authHeader) {
    token = extractToken(req);
    if (!token) {
      configService.log('Authorization header present but malformed');
      sendUnauthorized(
        res,
        'Bearer error="invalid_token", error_description="The access token is invalid"',
        'Access token missing or invalid',
      );
      return false;
    }

    let claims;
    try {
      claims = await jwksService.verifyToken(token);
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        configService.log('Token verification failed', { code: error.code });
        const mapped = TOKEN_ERROR_MAP[error.code] ?? {
          error: 'invalid_token',
          description: 'The access token is invalid',
        };
        sendUnauthorized(
          res,
          `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
          mapped.description,
        );
        return false;
      }
      sendUnauthorized(
        res,
        'Bearer error="invalid_token", error_description="The access token is invalid"',
        'Access token missing or invalid',
      );
      return false;
    }

    user = transformJwtToBridgeUser(claims);
    const tenant = transformJwtToBridgeTenant(claims);

    req.bridgeUser = user;
    req.bridgeTenant = tenant || undefined;
    req.bridgeAccessToken = token;
    // TBP-745 — the only place a verified token is registered for
    // `bridge.fromRequest(req)` and the quota middleware.
    rememberVerifiedUserToken(req, token, claims);

    configService.log('User authenticated', { userId: user.id, tenantId: user.tenantId });
  }

  // 7. Require at least one valid credential
  if (!apiTokenClaims && !user) {
    configService.log('No Authorization header');
    sendUnauthorized(
      res,
      'Bearer error="missing_token", error_description="No authorization token was provided"',
      'No authorization token was provided',
    );
    return false;
  }

  // 8. API-token privilege check (@RequirePrivilege analogue) — an API token's
  //    scope, for machine callers. It is not a gate on a person: user JWTs are
  //    gated by flags below.
  if (apiTokenClaims) {
    const requiredPrivilege = options.privilege;
    if (requiredPrivilege) {
      const privileges = apiTokenClaims.privileges ?? [];
      if (!privileges.includes(requiredPrivilege)) {
        configService.log('Privilege check failed', {
          required: requiredPrivilege,
          actual: privileges,
        });
        sendForbidden(res, `Privilege '${requiredPrivilege}' required`);
        return false;
      }
      configService.log('Privilege check passed', { privilege: requiredPrivilege });
    }
  }

  // 9. User-JWT-only checks: the flag from protect() or the matched route rule.
  if (user) {
    // Feature flag requirement — user JWT only. Sourced from either the
    // protect() option OR the matched config route rule.
    const requiredFlag = options.featureFlag ?? matchingRule?.featureFlag;
    if (requiredFlag && token) {
      const flagEnabled = await featureFlagService.evaluateRequirement(requiredFlag, token);
      if (!flagEnabled) {
        const flagName =
          typeof requiredFlag === 'string' ? requiredFlag : JSON.stringify(requiredFlag);
        const verdict = explainFlagFailure(featureFlagService, requiredFlag, token);
        configService.log('Feature flag check failed', {
          flag: flagName,
          reason: verdict?.explanation?.reason,
        });
        // TBP-756 — 402 FEATURE_NOT_IN_PLAN / 403 FEATURE_NOT_PERMITTED /
        // 403 FEATURE_OFF, naming the flag and the fix.
        const body = featureRefusalBody(flagName, verdict?.explanation, configService.manageRoute);
        res.status(body.statusCode).json(body);
        return false;
      }
      configService.log('Feature flag check passed', { flag: requiredFlag });
    }
  }

  return true;
}

/**
 * TBP-756 — why the requirement just refused is off, from the reasons Bridge
 * sent with that evaluation. Undefined (→ 403 FEATURE_OFF) when the service
 * cannot say — e.g. a custom FeatureFlagService without `explainFailure`.
 */
function explainFlagFailure(
  featureFlagService: FeatureFlagService,
  requirement: FeatureFlagRequirement,
  token: string,
): RequirementVerdict | undefined {
  const svc = featureFlagService as Partial<FeatureFlagService>;
  if (typeof svc.explainFailure !== 'function') return undefined;
  try {
    return svc.explainFailure.call(featureFlagService, requirement, token);
  } catch {
    return undefined;
  }
}

/**
 * Creates the auth middleware that reads config rules and defaultAccess.
 * Use as router/app-level middleware.
 */
export function createAuthMiddleware(
  configService: BridgeConfigService,
  jwksService: JwksService,
  featureFlagService: FeatureFlagService,
  bridgeService: BridgeService,
): RequestHandler {
  const deps: GuardDeps = { configService, jwksService, featureFlagService, bridgeService };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const path = req.path;
    const method = req.method;

    configService.log(`Auth middleware checking: ${method} ${path}`);

    // 1. Check if route was marked public by bridge.public() middleware
    if (req.__bridgePublic) {
      configService.log('Route is public (__bridgePublic flag)');
      next();
      return;
    }

    // 2. Check route rules from config
    const matchingRule = configService.findMatchingRule(path, method);

    if (matchingRule?.privilege === 'ANONYMOUS') {
      configService.log('Route is public (config rule: ANONYMOUS)', { path: matchingRule.path });
      next();
      return;
    }

    // 3. If no rule matches and default is public, allow
    if (!matchingRule && configService.defaultAccess === 'public') {
      configService.log('Route allowed (default access: public)');
      next();
      return;
    }

    // 4-9. Run the shared credential + authorization guard.
    const allowed = await runGuard(req, res, deps, matchingRule, {});
    if (allowed) {
      next();
    }
  };
}

/**
 * Creates the protect middleware that always enforces auth with optional local
 * overrides (the decorator analogue). Use per-route to enforce auth regardless
 * of defaultAccess.
 */
export function createProtectMiddleware(
  configService: BridgeConfigService,
  jwksService: JwksService,
  featureFlagService: FeatureFlagService,
  bridgeService: BridgeService,
  options?: BridgeMiddlewareOptions,
): RequestHandler {
  // TBP-745 — removed gates fail at startup, not per request.
  assertProtectOptions(options);
  const deps: GuardDeps = { configService, jwksService, featureFlagService, bridgeService };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const path = req.path;
    const method = req.method;

    configService.log(`Protect middleware checking: ${method} ${path}`);

    // protect() always enforces auth — its options ARE the rule, so it does not
    // consult config route rules.
    const allowed = await runGuard(req, res, deps, null, options ?? {});
    if (allowed) {
      next();
    }
  };
}

/**
 * Creates the public middleware that marks a route as public.
 * Sets req.__bridgePublic = true so auth() middleware skips auth.
 */
export function createPublicMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.__bridgePublic = true;
    next();
  };
}

/** Write a 401 with an RFC 6750 WWW-Authenticate header. */
function sendUnauthorized(res: Response, wwwAuthenticate: string, message: string): void {
  res.set('WWW-Authenticate', wwwAuthenticate);
  res.status(401).json({
    statusCode: 401,
    error: 'Unauthorized',
    message,
  });
}

/** Write a 403 forbidden response. */
function sendForbidden(res: Response, message: string): void {
  res.status(403).json({
    statusCode: 403,
    error: 'Forbidden',
    message,
  });
}

/**
 * Detect JWT shape: 3 non-empty base64url segments separated by dots.
 */
function isJwtShaped(token: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Extract bearer token from Authorization header
 */
function extractToken(request: Request): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const [type, token] = authHeader.split(' ');
  if (type.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}
