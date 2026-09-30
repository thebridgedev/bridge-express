// Factory
export { createBridge } from './bridge';
export type { BridgeExpressInstance, BridgeMiddlewareOptions, AuthType } from './bridge';

// Unified backend surface (TBP-341)
export { BridgeService, TenantScope } from './bridge';
export type {
  BrandingSnapshot,
  SubscriptionSnapshot,
  UserSnapshot,
  SessionSnapshotData,
  TenantEntitlementsView,
} from './bridge';

// Services
export { BridgeConfigService } from './services/bridge-config.service';
export { JwksService, TokenVerificationError } from './services/jwks.service';
export type { ApiTokenClaims } from './services/jwks.service';
export { FeatureFlagService } from './services/feature-flag.service';
export type { RequirementVerdict } from './services/feature-flag.service';

// Flag refusals that name the reason (TBP-756)
export { featureRefusalBody, readExplanation, DEFAULT_MANAGE_ROUTE } from './flags/feature-refusal';
export type {
  FeatureOffReason,
  FeatureOffExplanation,
  FeatureRefusalBody,
  FeatureRefusalCode,
} from './flags/feature-refusal';
export { BridgeHttpService, BridgeHttpError } from './services/bridge-http.service';

// Types
export type {
  BridgeConfig,
  GuardConfig,
  RouteRule,
  RoutePrivilege,
  FeatureFlagRequirement,
  BillingConfig,
} from './types/config';
export { BRIDGE_DEFAULTS } from './types/config';

export type { BridgeUser, JwtClaims } from './types/user';
export { transformJwtToBridgeUser } from './types/user';

export type { BridgeTenant } from './types/tenant';
export { transformJwtToBridgeTenant } from './types/tenant';
