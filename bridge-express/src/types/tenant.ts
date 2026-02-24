import { JwtClaims } from './user';

/**
 * Tenant/workspace information extracted from JWT
 */
export interface BridgeTenant {
  /** Tenant ID */
  id: string;
  /** Tenant name */
  name: string;
  /** Tenant locale preference */
  locale?: string;
  /** Tenant logo URL */
  logo?: string;
  /** Whether tenant has completed onboarding */
  onboarded?: boolean;
}

/**
 * Transform raw JWT claims into BridgeTenant
 */
export function transformJwtToBridgeTenant(claims: JwtClaims): BridgeTenant | null {
  const tenantId = claims.tid || claims.tenant_id;
  if (!tenantId) {
    return null;
  }

  return {
    id: tenantId,
    name: claims.tenant_name || '',
    locale: claims.tenant_locale,
    logo: claims.tenant_logo,
    onboarded: claims.tenant_onboarded,
  };
}
