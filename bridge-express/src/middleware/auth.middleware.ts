import { Request, Response, NextFunction, RequestHandler } from 'express';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError } from '../services/jwks.service';
import { FeatureFlagService } from '../services/feature-flag.service';
import { transformJwtToBridgeUser } from '../types/user';
import { transformJwtToBridgeTenant } from '../types/tenant';
import { FeatureFlagRequirement } from '../types/config';
import { BridgeUser } from '../types/user';
import { BridgeTenant } from '../types/tenant';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      bridgeUser?: BridgeUser;
      bridgeTenant?: BridgeTenant;
      bridgeAccessToken?: string;
      __bridgePublic?: boolean;
    }
  }
}

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
};

export interface BridgeMiddlewareOptions {
  role?: string;
  featureFlag?: FeatureFlagRequirement;
}

/**
 * Creates the auth middleware that reads config rules and defaultAccess.
 * Use as router/app-level middleware.
 */
export function createAuthMiddleware(
  configService: BridgeConfigService,
  jwksService: JwksService,
  featureFlagService: FeatureFlagService,
): RequestHandler {
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

    if (matchingRule?.public) {
      configService.log('Route is public (config rule)', { path: matchingRule.path });
      next();
      return;
    }

    // 3. If no rule matches and default is public, allow
    if (!matchingRule && configService.defaultAccess === 'public') {
      configService.log('Route allowed (default access: public)');
      next();
      return;
    }

    // 4. Extract and validate token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      configService.log('No Authorization header');
      res.set(
        'WWW-Authenticate',
        'Bearer error="missing_token", error_description="No authorization token was provided"',
      );
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'No authorization token was provided',
      });
      return;
    }

    const token = extractToken(req);
    if (!token) {
      configService.log('Authorization header present but malformed');
      res.set(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token missing or invalid',
      });
      return;
    }

    // 5. Verify JWT
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
        res.set(
          'WWW-Authenticate',
          `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
        );
        res.status(401).json({
          statusCode: 401,
          error: 'Unauthorized',
          message: mapped.description,
        });
        return;
      }
      res.set(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token missing or invalid',
      });
      return;
    }

    // 6. Attach user and tenant to request
    const user = transformJwtToBridgeUser(claims);
    const tenant = transformJwtToBridgeTenant(claims);

    req.bridgeUser = user;
    req.bridgeTenant = tenant || undefined;
    req.bridgeAccessToken = token;

    configService.log('User authenticated', { userId: user.id, tenantId: user.tenantId });

    // 7. Check role requirement from config rule
    const requiredRole = matchingRule?.role;
    if (requiredRole) {
      if (user.role !== requiredRole) {
        configService.log('Role check failed', { required: requiredRole, actual: user.role });
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: `Role '${requiredRole}' required`,
        });
        return;
      }
      configService.log('Role check passed', { role: requiredRole });
    }

    // 8. Check feature flag requirement from config rule
    const requiredFlag = matchingRule?.featureFlag;
    if (requiredFlag) {
      const flagEnabled = await featureFlagService.evaluateRequirement(requiredFlag, token);
      if (!flagEnabled) {
        const flagName =
          typeof requiredFlag === 'string' ? requiredFlag : JSON.stringify(requiredFlag);
        configService.log('Feature flag check failed', { flag: flagName });
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: `Feature flag '${flagName}' is not enabled`,
        });
        return;
      }
      configService.log('Feature flag check passed', { flag: requiredFlag });
    }

    next();
  };
}

/**
 * Creates the protect middleware that always enforces auth with optional local overrides.
 * Use per-route to enforce auth regardless of defaultAccess.
 */
export function createProtectMiddleware(
  configService: BridgeConfigService,
  jwksService: JwksService,
  featureFlagService: FeatureFlagService,
  options?: BridgeMiddlewareOptions,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const path = req.path;
    const method = req.method;

    configService.log(`Protect middleware checking: ${method} ${path}`);

    // Always requires auth — extract and validate token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      configService.log('No Authorization header');
      res.set(
        'WWW-Authenticate',
        'Bearer error="missing_token", error_description="No authorization token was provided"',
      );
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'No authorization token was provided',
      });
      return;
    }

    const token = extractToken(req);
    if (!token) {
      configService.log('Authorization header present but malformed');
      res.set(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token missing or invalid',
      });
      return;
    }

    // Verify JWT
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
        res.set(
          'WWW-Authenticate',
          `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
        );
        res.status(401).json({
          statusCode: 401,
          error: 'Unauthorized',
          message: mapped.description,
        });
        return;
      }
      res.set(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token missing or invalid',
      });
      return;
    }

    // Attach user and tenant to request
    const user = transformJwtToBridgeUser(claims);
    const tenant = transformJwtToBridgeTenant(claims);

    req.bridgeUser = user;
    req.bridgeTenant = tenant || undefined;
    req.bridgeAccessToken = token;

    configService.log('User authenticated', { userId: user.id, tenantId: user.tenantId });

    // Check role from options (overrides config)
    const requiredRole = options?.role;
    if (requiredRole) {
      if (user.role !== requiredRole) {
        configService.log('Role check failed', { required: requiredRole, actual: user.role });
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: `Role '${requiredRole}' required`,
        });
        return;
      }
      configService.log('Role check passed', { role: requiredRole });
    }

    // Check feature flag from options (overrides config)
    const requiredFlag = options?.featureFlag;
    if (requiredFlag) {
      const flagEnabled = await featureFlagService.evaluateRequirement(requiredFlag, token);
      if (!flagEnabled) {
        const flagName =
          typeof requiredFlag === 'string' ? requiredFlag : JSON.stringify(requiredFlag);
        configService.log('Feature flag check failed', { flag: flagName });
        res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: `Feature flag '${flagName}' is not enabled`,
        });
        return;
      }
      configService.log('Feature flag check passed', { flag: requiredFlag });
    }

    next();
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
